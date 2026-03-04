from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime, timedelta

from app.extensions import mongo
from routes.helpers import _add_months
from routes.helpers import _get_user_and_household
from routes.helpers import _is_admin
from routes.helpers import _parse_date
from routes.helpers import _round2
from routes.helpers import _to_object_id

bills_bp = Blueprint("bills", __name__, url_prefix="/bills")


def _can_manage_bill(user_doc, bill_doc, current_user_oid) -> bool:
    return bool(_is_admin(user_doc) or bill_doc.get("created_by") == current_user_oid)

def _parse_recurrence_bill(raw):
    if raw is None:
        return None, None
    
    if not isinstance(raw, dict):
        return None, (jsonify({"error": "recurrence must be an object"}), 400)
    
    freq = (raw.get("freq") or "").strip().lower()
    interval = raw.get("interval", 1)
    
    if freq == "biweekly":
        # store biweekly as weekly + interval=2 for a single backend shape
        freq = "weekly"
        interval = 2
    
    if freq not in ("weekly", "monthly", "quarterly"):
        return None, (jsonify({"error": "bill recurrence frequency must be weekly, biweekly, monthly or quarterly"}), 400)
    
    try:
        interval = int(interval)
    except Exception:
        return None, (jsonify({"error": "recurrence.interval must be an integer"}), 400)
    
    if interval < 1 or interval > 52:
        return None, (jsonify({"error": "recurrence.interval must be between 1 and 52"}), 400)
    
    return {"freq": freq, "interval": interval}, None

def _next_due_date_bill(due_date: datetime, recurrence: dict) -> datetime:
    freq = recurrence["freq"]
    interval = int(recurrence.get("interval", 1) or 1)
    
    if freq == "weekly":
        return due_date + timedelta(days=7 * interval)
    if freq == "monthly":
        return _add_months(due_date, interval)
    if freq == "quarterly":
        return _add_months(due_date, 3 * interval)
    
    return due_date

def _build_equal_splits(amount: float, member_oids: list):
    """Equal split to 2dp, adjusting the last member to avoid rounding drift."""
    n = len(member_oids)
    per = _round2(amount / n)

    splits = []
    running = 0.0

    for idx, member_id in enumerate(member_oids):
        if idx == n - 1:
            owed = _round2(amount - running)
        else:
            owed = per
            running = _round2(running + owed)

        splits.append({
            "user_id": member_id,
            "amount_owed": owed,
            "paid": False,
            "paid_at": None,
        })

    return splits


def _build_custom_splits(amount: float, raw_splits, member_oids: list):
    if raw_splits is None:
        return None, (jsonify({"error": "splits is required for custom split"}), 400)

    if not isinstance(raw_splits, list):
        return None, (jsonify({"error": "splits must be a list"}), 400)

    member_strs = {str(m) for m in member_oids}
    seen = set()
    parsed = []

    for idx, s in enumerate(raw_splits):
        if not isinstance(s, dict):
            return None, (jsonify({"error": f"splits[{idx}] must be an object"}), 400)

        uid_str = (s.get("user_id") or "").strip()
        if not uid_str:
            return None, (jsonify({"error": f"splits[{idx}].user_id is required"}), 400)

        if uid_str in seen:
            return None, (jsonify({"error": "duplicate user_id in splits"}), 400)

        uid_oid = _to_object_id(uid_str)
        if not uid_oid:
            return None, (jsonify({"error": f"invalid user_id in splits[{idx}]"}), 400)

        if uid_str not in member_strs:
            return None, (jsonify({"error": "all splits must be household members"}), 400)

        try:
            owed = _round2(s.get("amount_owed"))
        except (TypeError, ValueError):
            return None, (jsonify({"error": f"splits[{idx}].amount_owed must be a number"}), 400)

        if owed < 0:
            return None, (jsonify({"error": f"splits[{idx}].amount_owed must be >= 0"}), 400)

        parsed.append((uid_oid, owed))
        seen.add(uid_str)

    # custom split must include each member exactly once
    if seen != member_strs:
        missing = sorted(list(member_strs - seen))
        extra = sorted(list(seen - member_strs))
        msg = {"error": "splits must include every household member exactly once"}
        if missing:
            msg["missing_member_ids"] = missing
        if extra:
            msg["extra_member_ids"] = extra
        return None, (jsonify(msg), 400)

    total = _round2(sum(owed for _, owed in parsed))
    diff = _round2(amount - total)

    # if out by 1-2 pennies due to rounding adjust the last entry
    if diff != 0:
        uid_oid, last_owed = parsed[-1]
        adjusted = _round2(last_owed + diff)
        if adjusted < 0:
            return None, (jsonify({"error": "custom splits total does not match bill amount"}), 400)
        parsed[-1] = (uid_oid, adjusted)

        total2 = _round2(sum(owed for _, owed in parsed))
        if total2 != _round2(amount):
            return None, (jsonify({"error": "custom splits total must equal bill amount"}), 400)

    splits = [
        {"user_id": uid_oid, "amount_owed": owed, "paid": False, "paid_at": None}
        for uid_oid, owed in parsed
    ]
    return splits, None


def _bill_to_json(bill, current_user_oid=None, user_lookup=None):
    #Convert a bill document to JSON-safe dict including per-user values
    splits = bill.get("splits", [])
    your_split = None
    split_json = []
    email_cache = {}

    for s in splits:
        split_user_id = s.get("user_id")
        split_user_id_str = str(split_user_id) if split_user_id else None

        if current_user_oid and split_user_id == current_user_oid:
            your_split = s

        email = None
        if split_user_id_str:
            if user_lookup and split_user_id_str in user_lookup:
                email = user_lookup[split_user_id_str]
            else:
                # local cache avoids repeating user lookups across split rows
                if split_user_id_str not in email_cache:
                    user_doc = mongo.db.users.find_one({"_id": split_user_id}, {"email": 1})
                    email_cache[split_user_id_str] = user_doc.get("email") if user_doc else None
                email = email_cache[split_user_id_str]

        split_json.append({
            "user_id": split_user_id_str,
            "email": email,
            "is_you": bool(current_user_oid and split_user_id == current_user_oid),
            "amount_owed": float(s.get("amount_owed", 0)),
            "paid": bool(s.get("paid", False)),
            "paid_at": s.get("paid_at").isoformat() if s.get("paid_at") else None,
        })

    return {
        "bill_id": str(bill["_id"]),
        "household_id": str(bill["household_id"]),
        "title": bill.get("title"),
        "amount": float(bill.get("amount", 0)),
        "due_date": bill.get("due_date").date().isoformat() if bill.get("due_date") else None,
        "created_by": str(bill["created_by"]) if bill.get("created_by") else None,
        "split_type": bill.get("split_type", "equal"),
        "status": bill.get("status", "open"),
        "archived": bool(bill.get("archived", False)),
        "archived_at": bill.get("archived_at").isoformat() if bill.get("archived_at") else None,
        "archived_by": str(bill["archived_by"]) if bill.get("archived_by") else None,
        "created_at": bill.get("created_at").isoformat() if bill.get("created_at") else None,
        "splits": split_json,
        "your_share": float(your_split.get("amount_owed")) if your_split else None,
        "you_paid": bool(your_split.get("paid")) if your_split else None,
        "recurrence": bill.get("recurrence"),
        "reminder_days_before": int(bill.get("reminder_days_before", 3) or 3),
    }


@bills_bp.post("")
@jwt_required()
def create_bill():
    data = request.get_json(force=True) or {}

    title = (data.get("title") or "").strip()
    amount = data.get("amount")
    due_date_str = (data.get("due_date") or "").strip()
    split_type = (data.get("split_type") or "equal").strip().lower()

    if not title:
        return jsonify({"error": "title is required"}), 400

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400

    if amount <= 0:
        return jsonify({"error": "amount must be greater than 0"}), 400

    if split_type not in ("equal", "custom"):
        return jsonify({"error": "split_type must be 'equal' or 'custom'"}), 400

    due_date = _parse_date(due_date_str)
    if due_date_str and not due_date:
        return jsonify({"error": "due_date must be YYYY-MM-DD"}), 400
    
    recurrence, rec_err = _parse_recurrence_bill(data.get("recurrence"))
    if rec_err:
        return rec_err
    
    reminder_days_before = data.get("reminder_days_before", 3)
    try:
        reminder_days_before = int(reminder_days_before)
    except Exception:
        return jsonify({"error": "reminder_days_before must be an integer"}), 400
    
    if reminder_days_before < 0 or reminder_days_before > 60:
        return jsonify({"error": "reminder_days_before must be 0-60"}), 400
    
    if recurrence and not due_date:
        return jsonify({"error": "recurring bills require a due_date"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    member_oids = household.get("members", [])
    if not member_oids:
        return jsonify({"error": "household has no members"}), 400

    if split_type == "equal":
        splits = _build_equal_splits(amount, member_oids)
    else:
        splits, split_err = _build_custom_splits(amount, data.get("splits"), member_oids)
        if split_err:
            return split_err

    bill_doc = {
        "household_id": household["_id"],
        "title": title,
        "amount": amount,
        "due_date": due_date,
        "created_by": current_user_oid,
        "split_type": split_type,
        "splits": splits,
        "status": "open",
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
        "recurrence": recurrence,
        "reminder_days_before": reminder_days_before,
        "next_generated": False,
        "archived": False,
        "archived_at": None,
        "archived_by": None,
    }

    bills = mongo.db.bills
    res = bills.insert_one(bill_doc)
    bill = bills.find_one({"_id": res.inserted_id})

    return jsonify({"bill": _bill_to_json(bill, current_user_oid)}), 201


@bills_bp.get("")
@jwt_required()
def list_bills():
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    include_archived = (request.args.get("include_archived") or "").strip().lower() in ("1", "true", "yes")
    q = {"household_id": household["_id"]}
    if not include_archived:
        # default view hides archived bills
        q["archived"] = {"$ne": True}

    bills = mongo.db.bills
    docs = bills.find(q).sort([
        ("due_date", 1),
        ("created_at", -1),
    ])

    return jsonify({"bills": [_bill_to_json(bill, current_user_oid) for bill in docs]}), 200


@bills_bp.get("/<bill_id>")
@jwt_required()
def get_bill(bill_id):
    bill_oid = _to_object_id(bill_id)
    if not bill_oid:
        return jsonify({"error": "invalid bill id"}), 400

    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    bills = mongo.db.bills
    bill = bills.find_one({"_id": bill_oid, "household_id": household["_id"]})
    if not bill:
        return jsonify({"error": "bill not found"}), 404

    return jsonify({"bill": _bill_to_json(bill, current_user_oid)}), 200


@bills_bp.patch("/<bill_id>")
@jwt_required()
def update_bill(bill_id):
    bill_oid = _to_object_id(bill_id)
    if not bill_oid:
        return jsonify({"error": "invalid bill id"}), 400

    data = request.get_json(force=True) or {}

    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    bills = mongo.db.bills
    bill = bills.find_one({"_id": bill_oid, "household_id": household["_id"]})
    if not bill:
        return jsonify({"error": "bill not found"}), 404

    updates = {}

    if "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "title cannot be empty"}), 400
        updates["title"] = title

    if "due_date" in data:
        due_date_str = (data.get("due_date") or "").strip()
        due_date = _parse_date(due_date_str) if due_date_str else None
        if due_date_str and not due_date:
            return jsonify({"error": "due_date must be YYYY-MM-DD"}), 400
        updates["due_date"] = due_date

    amount_changed = False
    if "amount" in data:
        try:
            amt = float(data.get("amount"))
        except (TypeError, ValueError):
            return jsonify({"error": "amount must be a number"}), 400
        if amt <= 0:
            return jsonify({"error": "amount must be greater than 0"}), 400
        updates["amount"] = amt
        amount_changed = True

    existing_split_type = (bill.get("split_type") or "equal").strip().lower()
    next_split_type = (data.get("split_type") or existing_split_type).strip().lower()

    if next_split_type not in ("equal", "custom"):
        return jsonify({"error": "split_type must be 'equal' or 'custom'"}), 400

    if "split_type" in data:
        updates["split_type"] = next_split_type

    member_oids = household.get("members", [])
    final_amount = float(updates.get("amount", bill.get("amount", 0)))

    if next_split_type == "equal":
        if amount_changed or ("split_type" in data):
            # amount/split changes invalidate previous paid state
            updates["splits"] = _build_equal_splits(final_amount, member_oids)
            updates["status"] = "open"

    if next_split_type == "custom":
        raw_splits_present = "splits" in data
        if (amount_changed or ("split_type" in data)) and not raw_splits_present:
            return jsonify({"error": "custom split requires splits when changing amount or split_type"}), 400

        if raw_splits_present:
            splits, split_err = _build_custom_splits(final_amount, data.get("splits"), member_oids)
            if split_err:
                return split_err
            # replacing custom splits also resets status to open
            updates["splits"] = splits
            updates["status"] = "open"

    if not updates:
        return jsonify({"error": "no valid fields to update"}), 400

    bills.update_one(
        {"_id": bill_oid, "household_id": household["_id"]},
        {"$set": {**updates, "updated_at": datetime.utcnow()}},
    )

    bill = bills.find_one({"_id": bill_oid})
    return jsonify({"bill": _bill_to_json(bill, current_user_oid)}), 200


@bills_bp.patch("/<bill_id>/pay")
@jwt_required()
def set_my_payment_status(bill_id):
    bill_oid = _to_object_id(bill_id)
    if not bill_oid:
        return jsonify({"error": "invalid bill id"}), 400

    data = request.get_json(force=True) or {}
    paid = data.get("paid")
    if paid is None or not isinstance(paid, bool):
        return jsonify({"error": "paid must be true or false"}), 400

    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    bills = mongo.db.bills
    bill = bills.find_one({"_id": bill_oid, "household_id": household["_id"]})
    if not bill:
        return jsonify({"error": "bill not found"}), 404

    if bill.get("archived", False):
        return jsonify({"error": "cannot change payment on archived bill; unarchive first"}), 400

    splits = bill.get("splits", [])
    idx = None
    # find the caller row inside split array
    for i, s in enumerate(splits):
        if s.get("user_id") == current_user_oid:
            idx = i
            break
    if idx is None:
        return jsonify({"error": "you are not a member of this bill split"}), 403

    set_fields = {
        f"splits.{idx}.paid": paid,
        f"splits.{idx}.paid_at": datetime.utcnow() if paid else None,
        "updated_at": datetime.utcnow(),
    }

    bills.update_one({"_id": bill_oid}, {"$set": set_fields})
    bill = bills.find_one({"_id": bill_oid})
    all_paid = all(bool(s.get("paid")) for s in bill.get("splits", [])) and len(bill.get("splits", [])) > 0

    # generate next recurring bill once when current cycle becomes fully paid
    if all_paid and bill.get("recurrence") and bill.get("due_date") and not bill.get("next_generated", False):
        recurrence = bill["recurrence"]
        next_due = _next_due_date_bill(bill["due_date"], recurrence)

        member_oids = household.get("members", [])
        old_splits = bill.get("splits", [])
        old_user_ids = {s.get("user_id") for s in old_splits}
        member_set = set(member_oids)

        if bill.get("split_type") == "custom" and old_user_ids == member_set:
            next_splits = [{"user_id": s["user_id"], "amount_owed": float(s.get("amount_owed", 0)), "paid": False, "paid_at": None} for s in old_splits]
            next_split_type = "custom"
        else:
            next_splits = _build_equal_splits(float(bill.get("amount", 0)), member_oids)
            next_split_type = "equal"

        next_bill_doc = {
            "household_id": bill["household_id"],
            "title": bill.get("title"),
            "amount": float(bill.get("amount", 0)),
            "due_date": next_due,
            "created_by": bill.get("created_by") or current_user_oid,
            "split_type": next_split_type,
            "splits": next_splits,
            "status": "open",
            "recurrence": bill.get("recurrence"),
            "reminder_days_before": int(bill.get("reminder_days_before", 3) or 3),
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
            "generated_from": bill["_id"],
            "archived": False,
            "archived_at": None,
            "archived_by": None,
        }

        ins = bills.insert_one(next_bill_doc)
        bills.update_one(
            {"_id": bill_oid},
            {"$set": {"next_generated": True, "next_bill_id": ins.inserted_id, "updated_at": datetime.utcnow()}},
        )

    bill = bills.find_one({"_id": bill_oid})
    all_paid = all(bool(s.get("paid")) for s in bill.get("splits", [])) and len(bill.get("splits", [])) > 0

    # keep bill status aligned with split-level paid flags
    if all_paid and bill.get("status") != "paid":
        bills.update_one({"_id": bill_oid}, {"$set": {"status": "paid", "updated_at": datetime.utcnow()}})
        bill = bills.find_one({"_id": bill_oid})
    elif (not all_paid) and bill.get("status") == "paid":
        bills.update_one({"_id": bill_oid}, {"$set": {"status": "open", "updated_at": datetime.utcnow()}})
        bill = bills.find_one({"_id": bill_oid})

    return jsonify({"bill": _bill_to_json(bill, current_user_oid)}), 200


@bills_bp.patch("/<bill_id>/archive")
@jwt_required()
def set_bill_archive_status(bill_id):
    bill_oid = _to_object_id(bill_id)
    if not bill_oid:
        return jsonify({"error": "invalid bill id"}), 400

    data = request.get_json(force=True) or {}
    archived = data.get("archived")
    if archived is None or not isinstance(archived, bool):
        return jsonify({"error": "archived must be true or false"}), 400

    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    bills = mongo.db.bills
    bill = bills.find_one({"_id": bill_oid, "household_id": household["_id"]})
    if not bill:
        return jsonify({"error": "bill not found"}), 404

    if not _can_manage_bill(user, bill, current_user_oid):
        return jsonify({"error": "not allowed"}), 403

    if archived and bill.get("status") != "paid":
        return jsonify({"error": "only paid bills can be archived"}), 400

    updates = {
        "archived": archived,
        "archived_at": datetime.utcnow() if archived else None,
        "archived_by": current_user_oid if archived else None,
        "updated_at": datetime.utcnow(),
    }
    bills.update_one({"_id": bill_oid}, {"$set": updates})

    bill = bills.find_one({"_id": bill_oid})
    return jsonify({"bill": _bill_to_json(bill, current_user_oid)}), 200


@bills_bp.delete("/<bill_id>")
@jwt_required()
def delete_bill(bill_id):
    bill_oid = _to_object_id(bill_id)
    if not bill_oid:
        return jsonify({"error": "invalid bill id"}), 400

    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    bills = mongo.db.bills
    bill = bills.find_one({"_id": bill_oid, "household_id": household["_id"]})
    if not bill:
        return jsonify({"error": "bill not found"}), 404

    if not _can_manage_bill(user, bill, current_user_oid):
        return jsonify({"error": "not allowed"}), 403

    bills.delete_one({"_id": bill_oid})
    return jsonify({"message": "bill deleted"}), 200
