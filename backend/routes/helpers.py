from datetime import date, datetime
from flask import jsonify
from bson import ObjectId
from bson.errors import InvalidId

from app.extensions import mongo


def _to_object_id(value: str):
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def _parse_date(value: str):
    if not value:
        return None
    try:
        d = date.fromisoformat(value)
        return datetime(d.year, d.month, d.day)
    except ValueError:
        return None


def _is_admin(user_doc) -> bool:
    return (user_doc or {}).get("role") == "admin"


def _get_user_and_household(user_id_str: str):
    users = mongo.db.users
    households = mongo.db.households

    user = users.find_one({"_id": _to_object_id(user_id_str)})
    if not user:
        return None, None, (jsonify({"error": "user not found"}), 404)

    household_id = user.get("household_id")
    if not household_id:
        return user, None, (jsonify({"error": "user not in a household"}), 400)

    household = households.find_one({"_id": household_id})
    if not household:
        return user, None, (jsonify({"error": "household not found"}), 404)

    return user, household, None


def _round2(x: float) -> float:
    return round(float(x), 2)


def _last_day_of_month(year: int, month: int) -> int:
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
        return 29 if leap else 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


def _add_months(dt: datetime, months: int) -> datetime:
    y = dt.year
    m0 = dt.month - 1 + months
    y += m0 // 12
    m = (m0 % 12) + 1
    d = min(dt.day, _last_day_of_month(y, m))
    return dt.replace(year=y, month=m, day=d)


def _user_email_lookup(user_ids):
    if not user_ids:
        return {}
    docs = mongo.db.users.find({"_id": {"$in": list(user_ids)}}, {"email": 1})
    return {str(d["_id"]): d.get("email") for d in docs}
