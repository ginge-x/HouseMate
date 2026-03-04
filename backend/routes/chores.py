from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from bson import ObjectId
from datetime import datetime, timedelta

from app.extensions import mongo
from routes.helpers import _add_months
from routes.helpers import _get_user_and_household
from routes.helpers import _is_admin
from routes.helpers import _parse_date
from routes.helpers import _to_object_id


chores_bp = Blueprint("chores", __name__, url_prefix="/chores")

def _can_manage_chore(user_doc, chore_doc, current_user_oid) -> bool:
    return bool(_is_admin(user_doc) or chore_doc.get("created_by") == current_user_oid)

#Assign to the member with the least open chores
#Tie-breaker: earliest email OR member order
def _auto_assign_user(household_id: ObjectId, member_oids: list[ObjectId]) -> ObjectId:
    chores = mongo.db.chores
    users = mongo.db.users
    
    #count incomplete chores per member
    pipeline = [
        {"$match": {"household_id": household_id, "completed": False, "assigned_to": {"$in": member_oids}}},
        {"$group": {"_id": "$assigned_to", "count": {"$sum": 1}}},
    ]
    counts = {doc["_id"]: doc["count"] for doc in chores.aggregate(pipeline)}

    #tie break by email for consistency
    members = list(users.find({"_id": {"$in": member_oids}}, {"email": 1}))
    members.sort(key=lambda m: (m.get("email") or "").lower())
    
    best = None
    best_count = None
    for m in members:
        mid = m["_id"]
        c = counts.get(mid, 0)
        if best is None or c < best_count:
            best = mid
            best_count = c
    
    return best or member_oids[0]

def _parse_recurrence_chore(raw):
    if raw is None:
        return None, None

    if not isinstance(raw, dict):
        return None, (jsonify({"error": "recurrence must be an object"}), 400)

    freq = (raw.get("freq") or "").strip().lower()
    interval = raw.get("interval", 1)

    if freq == "biweekly":
        # store biweekly as weekly + interval=2 for one backend shape
        freq = "weekly"
        interval = 2

    if freq not in ("daily", "weekly", "monthly"):
        return None, (jsonify({"error": "chore recurrence freq must be daily/weekly/biweekly/monthly"}), 400)

    try:
        interval = int(interval)
    except Exception:
        return None, (jsonify({"error": "recurrence.interval must be an integer"}), 400)

    if interval < 1 or interval > 365:
        return None, (jsonify({"error": "recurrence.interval must be between 1 and 365"}), 400)

    return {"freq": freq, "interval": interval}, None

def _chore_to_json(chore):
    return{
        "chore_id": str(chore["_id"]),
        "household_id": str(chore["household_id"]),
        "title": chore.get("title"),
        "assigned_to": str(chore["assigned_to"]) if chore.get("assigned_to") else None,
        "due_date": chore.get("due_date").date().isoformat() if chore.get("due_date") else None,
        "completed": bool(chore.get("completed", False)),
        "completed_at": chore.get("completed_at").isoformat() if chore.get("completed_at") else None,
        "archived": bool(chore.get("archived", False)),
        "archived_at": chore.get("archived_at").isoformat() if chore.get("archived_at") else None,
        "archived_by": str(chore["archived_by"]) if chore.get("archived_by") else None,
        "created_by": str(chore["created_by"]) if chore.get("created_by") else None,
        "created_at": chore.get("created_at").isoformat() if chore.get("created_at") else None,
        "updated_at": chore.get("updated_at").isoformat() if chore.get("updated_at") else None,
        "recurrence": chore.get("recurrence"),
        "reminder_days_before": int(chore.get("reminder_days_before",1) or 1),
    }

def _next_due_date_chore(due_date: datetime, recurrence: dict) -> datetime:
    freq = recurrence["freq"]
    interval = int(recurrence.get("interval", 1) or 1)

    if freq == "daily":
        return due_date + timedelta(days=interval)
    if freq == "weekly":
        return due_date + timedelta(days=7 * interval)
    if freq == "monthly":
        return _add_months(due_date, interval)

    return due_date

@chores_bp.post("")
@jwt_required()
def create_chore():
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    due_date_str = (data.get("due_date") or "").strip()
    
    #assignment inputs: assigned_to can be a user_id OR "auto" OR ""/null
    assigned_to_raw = data.get("assigned_to")
    
    if not title:
        return jsonify({"error" : "title is required"}), 400
    
    due_date = _parse_date(due_date_str) if due_date_str else None
    if due_date_str and not due_date:
        return jsonify({"error" : "due_date must be YYYY-MM-DD"}), 400
    
    recurrence, rec_err = _parse_recurrence_chore(data.get("recurrence"))
    if rec_err:
        return rec_err
    
    reminder_days_before = data.get("reminder_days_before", 1)
    try:
        reminder_days_before = int(reminder_days_before)
    except Exception:
        return jsonify({"error": "reminder_days_before must be an integer"}), 400
    
    if reminder_days_before < 0 or reminder_days_before > 60:
        return jsonify({"error": "reminder_days_before must be 0-60"}), 400
    
    if recurrence and not due_date:
        return jsonify({"error": "recurring chores require a due_date"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error" : "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    member_oids = household.get("members", [])
    if not member_oids:
        return jsonify({"error": "household has no members"}), 400
    
    assigned_oid = None
    if isinstance(assigned_to_raw, str) and assigned_to_raw.strip().lower() == "auto":
        assigned_oid = _auto_assign_user(household["_id"], member_oids)
    elif assigned_to_raw:
        assigned_oid = _to_object_id(str(assigned_to_raw))
        if not assigned_oid:
            return jsonify({"error" : "assigned_to must be a valid user id or 'auto'"}), 400
        if assigned_oid not in member_oids:
            return jsonify({"error": "assigned_to must be a household member"}), 400
    else:
        assigned_oid = _auto_assign_user(household["_id"], member_oids)

    chore_doc = {
        "household_id": household["_id"],
        "title":  title,
        "assigned_to": assigned_oid,
        "due_date": due_date,
        "completed": False,
        "completed_at": None,
        "created_by": current_user_oid,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
        "recurrence": recurrence,
        "reminder_days_before": reminder_days_before,
        "next_generated": False,
        "archived": False,
        "archived_at": None,
        "archived_by": None,
    }
    
    chores = mongo.db.chores
    res = chores.insert_one(chore_doc)
    chore = chores.find_one({"_id": res.inserted_id})
    
    return jsonify({"chore": _chore_to_json(chore)}), 201

@chores_bp.get("")
@jwt_required()
def list_chores():
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err

    include_archived = (request.args.get("include_archived") or "").strip().lower() in ("1", "true", "yes")
    q = {"household_id": household["_id"]}
    if not include_archived:
        # default list excludes archived chores
        q["archived"] = {"$ne": True}
    
    chores = mongo.db.chores
    cursor = chores.find(q).sort([("completed", 1), ("due_date", 1), ("created_at", -1)])
    
    out = [_chore_to_json(c) for c in cursor]
    return jsonify({"chores": out}), 200

@chores_bp.patch("/<chore_id>")
@jwt_required()
def update_chore(chore_id):
    chore_oid = _to_object_id(chore_id)
    if not chore_oid:
        return jsonify({"error": "invalid chore id"}), 400
    
    data = request.get_json(force=True) or {}
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
        
    if not updates:
        return jsonify({"error": "no valid fields to update"}), 400
    
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    chores = mongo.db.chores
    res = chores.update_one(
        {"_id": chore_oid, "household_id": household["_id"]},
        {"$set": {**updates, "updated_at": datetime.utcnow()}}
    )
    if res.matched_count == 0:
        return jsonify({"error" : "chore not found"}), 404
    
    chore = chores.find_one({"_id": chore_oid})
    return jsonify({"chore": _chore_to_json(chore)}), 200

@chores_bp.patch("/<chore_id>/complete")
@jwt_required()
def set_complete(chore_id):
    chore_oid = _to_object_id(chore_id)
    if not chore_oid:
        return jsonify({"error": "invalid chore id"}), 400
    
    data = request.get_json(force=True) or {}
    completed = data.get("completed")
    if completed is None or not isinstance(completed, bool):
        return jsonify({"error": "completed must be true or false"}), 400
    
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    chores = mongo.db.chores
    res = chores.update_one(
        {"_id": chore_oid, "household_id": household["_id"]},
        {"$set": {
            "completed": completed,
            "completed_at": datetime.utcnow() if completed else None,
            "updated_at": datetime.utcnow()
        }}
    )
    if res.matched_count == 0:
        return jsonify({"error": "chore not found"}), 404

    chore = chores.find_one({"_id": chore_oid})

    # generate the next recurring chore only once per completed cycle
    if chore.get("completed") and chore.get("recurrence") and chore.get("due_date") and not chore.get("next_generated", False):
        member_oids = household.get("members", [])
        next_due = _next_due_date_chore(chore["due_date"], chore["recurrence"])
        next_assigned = _auto_assign_user(household["_id"], member_oids) if member_oids else None

        next_doc = {
            "household_id": chore["household_id"],
            "title": chore.get("title"),
            "assigned_to": next_assigned,
            "due_date": next_due,
            "completed": False,
            "completed_at": None,
            "created_by": chore.get("created_by"),
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
            "recurrence": chore.get("recurrence"),
            "reminder_days_before": int(chore.get("reminder_days_before", 1) or 1),
            "next_generated": False,
            "generated_from": chore["_id"],
            "archived": False,
            "archived_at": None,
            "archived_by": None,
        }

        ins = chores.insert_one(next_doc)
        chores.update_one(
            {"_id": chore_oid},
            {"$set": {"next_generated": True, "next_chore_id": ins.inserted_id, "updated_at": datetime.utcnow()}},
        )

    chore = chores.find_one({"_id": chore_oid})
    return jsonify({"chore": _chore_to_json(chore)}), 200


@chores_bp.patch("/<chore_id>/archive")
@jwt_required()
def set_chore_archive_status(chore_id):
    chore_oid = _to_object_id(chore_id)
    if not chore_oid:
        return jsonify({"error": "invalid chore id"}), 400

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

    chores = mongo.db.chores
    chore = chores.find_one({"_id": chore_oid, "household_id": household["_id"]})
    if not chore:
        return jsonify({"error": "chore not found"}), 404

    if not _can_manage_chore(user, chore, current_user_oid):
        return jsonify({"error": "not allowed"}), 403

    if archived and not chore.get("completed", False):
        return jsonify({"error": "only completed chores can be archived"}), 400

    updates = {
        "archived": archived,
        "archived_at": datetime.utcnow() if archived else None,
        "archived_by": current_user_oid if archived else None,
        "updated_at": datetime.utcnow(),
    }
    chores.update_one({"_id": chore_oid}, {"$set": updates})

    chore = chores.find_one({"_id": chore_oid})
    return jsonify({"chore": _chore_to_json(chore)}), 200


@chores_bp.patch("/<chore_id>/assign")
@jwt_required()
def assign_chore(chore_id):
    chore_oid = _to_object_id(chore_id)
    if not chore_oid:
        return jsonify({"error" : "invalid chore id"}), 400
    
    data = request.get_json(force=True) or {}
    assigned_to_raw = data.get("assigned_to")
    
    if not assigned_to_raw:
        return jsonify({"error" : "assigned_to is required (user id or 'auto')"}), 400
    
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    member_oids = household.get("members", [])
    if not member_oids:
        return jsonify({"error": "household has no members"}), 400
    
    if isinstance(assigned_to_raw, str) and assigned_to_raw.strip().lower() == "auto":
        # rebalance assignment using least-open-chore rule
        assigned_oid = _auto_assign_user(household["_id"], member_oids)
    else:
        assigned_oid = _to_object_id(str(assigned_to_raw))
        if not assigned_oid:
            return jsonify({"error": "assigned_to must be a valid user id or 'auto'"}), 400
        if assigned_oid not in member_oids:
            return jsonify({"error": "assigned_to must be a household member"}), 400
    
    chores = mongo.db.chores
    res = chores.update_one(
        {"_id": chore_oid, "household_id": household["_id"]},
        {"$set": {"assigned_to": assigned_oid, "updated_at": datetime.utcnow()}}
    )
    if res.matched_count == 0:
        return jsonify({"error": "chore not found"}), 404
    
    chore = chores.find_one({"_id": chore_oid})
    return jsonify({"chore": _chore_to_json(chore)}), 200

@chores_bp.delete("/<chore_id>")
@jwt_required()
def delete_chore(chore_id):
    chore_oid = _to_object_id(chore_id)
    if not chore_oid:
        return jsonify({"error": "invalid chore id"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400

    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    chores = mongo.db.chores
    chore = chores.find_one({"_id": chore_oid, "household_id": household["_id"]})
    if not chore:
        return jsonify({"error" : "chore not found"}), 404

    if not _can_manage_chore(user, chore, current_user_oid):
        return jsonify({"error": "not allowed"}), 403

    chores.delete_one({"_id": chore_oid})
    
    return jsonify({"message": "chore deleted"}), 200
