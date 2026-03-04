from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime, date
from app.extensions import mongo
from routes.helpers import _get_user_and_household
from routes.helpers import _to_object_id

reminders_bp = Blueprint("reminders", __name__, url_prefix="/reminders")

def _today_date_utc() -> date:
    return datetime.utcnow().date()

def _safe_int(v, default: int, min_v: int, max_v: int):
    try:
        x = int(v)
    except Exception:
        x = default
    return max(min_v, min(max_v, x))

@reminders_bp.get("")
@jwt_required()
def get_reminders():
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    days = _safe_int(request.args.get("days"), default=7, min_v=1, max_v=60)
    today = _today_date_utc()
    
    bills_cursor = mongo.db.bills.find({
        "household_id": household["_id"],
        "due_date": {"$ne": None},
        "status": {"$ne": "paid"},
    })
    
    bills_items = []
    for b in bills_cursor:
        due_dt = b.get("due_date")
        if not due_dt:
            continue

        due = due_dt.date()
        days_until = (due - today).days
        reminder_days = _safe_int(b.get("reminder_days_before", 3), default=3, min_v=0, max_v=60)
        # include if within user-requested range or item-specific reminder window
        threshold = max(days, reminder_days)

        if days_until <= threshold:
            your_share = None
            you_paid = None
            for s in (b.get("splits") or []):
                if s.get("user_id") == current_user_oid:
                    your_share = float(s.get("amount_owed", 0))
                    you_paid = bool(s.get("paid", False))
                    break

            bills_items.append(
                {
                    "type": "bill",
                    "bill_id": str(b["_id"]),
                    "title": b.get("title"),
                    "amount": float(b.get("amount", 0)),
                    "due_date": due.isoformat(),
                    "days_until_due": days_until,
                    "is_overdue": days_until < 0,
                    "in_reminder_window": days_until <= reminder_days,
                    "split_type": b.get("split_type", "equal"),
                    "your_share": your_share,
                    "you_paid": you_paid,
                    "recurrence": b.get("recurrence"),
                    "reminder_days_before": reminder_days,
                }
            )

    bills_items.sort(key=lambda x: x["due_date"])

    chores_cursor = mongo.db.chores.find(
        {
            "household_id": household["_id"],
            "due_date": {"$ne": None},
            "completed": False,
        }
    )

    chore_items = []
    for c in chores_cursor:
        due_dt = c.get("due_date")
        if not due_dt:
            continue

        due = due_dt.date()
        days_until = (due - today).days
        reminder_days = _safe_int(c.get("reminder_days_before", 1), default=1, min_v=0, max_v=60)
        threshold = max(days, reminder_days)

        if days_until <= threshold:
            chore_items.append(
                {
                    "type": "chore",
                    "chore_id": str(c["_id"]),
                    "title": c.get("title"),
                    "assigned_to": str(c.get("assigned_to")) if c.get("assigned_to") else None,
                    "due_date": due.isoformat(),
                    "days_until_due": days_until,
                    "is_overdue": days_until < 0,
                    "in_reminder_window": days_until <= reminder_days,
                    "recurrence": c.get("recurrence"),
                    "reminder_days_before": reminder_days,
                }
            )

    chore_items.sort(key=lambda x: x["due_date"])

    return (
        jsonify(
            {
                "today": today.isoformat(),
                "range_days": days,
                "bills": bills_items,
                "chores": chore_items,
            }
        ),
        200,
    )
