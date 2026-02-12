from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from bson import ObjectId
from datetime import datetime
import secrets
import string

from bson.errors import InvalidId
from app.extensions import mongo

households_bp = Blueprint("households", __name__, url_prefix="/households")


def _to_object_id(value: str):
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        return None


def _generate_invite_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


@households_bp.post("")
@jwt_required()
def create_household():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "household name is required"}), 400

    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households

    user = users.find_one({"_id": _to_object_id(current_user_id)})
    if not user:
        return jsonify({"error": "user not found"}), 404

    if user.get("household_id"):
        return jsonify({"error": "user already in a household"}), 400

    invite_code = None
    for _ in range(10):
        code = _generate_invite_code()
        if not households.find_one({"invite_code": code}):
            invite_code = code
            break

    if not invite_code:
        return jsonify({"error": "failed to generate invite code"}), 500

    household_doc = {
        "name": name,
        "invite_code": invite_code,
        "created_by": _to_object_id(current_user_id),
        "members": [_to_object_id(current_user_id)],
        "created_at": datetime.utcnow(),
    }

    res = households.insert_one(household_doc)
    household_id = res.inserted_id

    users.update_one(
        {"_id": _to_object_id(current_user_id)},
        {"$set": {"household_id": household_id}},
    )

    return jsonify({
        "household_id": str(household_id),
        "name": name,
        "invite_code": invite_code,
    }), 201


@households_bp.post("/join")
@jwt_required()
def join_household():
    data = request.get_json(force=True) or {}
    invite_code = (data.get("invite_code") or "").strip().upper()
    if not invite_code:
        return jsonify({"error": "invite_code is required"}), 400

    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households

    user = users.find_one({"_id": _to_object_id(current_user_id)})
    if not user:
        return jsonify({"error": "user not found"}), 404

    if user.get("household_id"):
        return jsonify({"error": "user already in a household"}), 400

    household = households.find_one({"invite_code": invite_code})
    if not household:
        return jsonify({"error": "invalid invite code"}), 404

    household_id = household["_id"]

    households.update_one(
        {"_id": household_id},
        {"$addToSet": {"members": _to_object_id(current_user_id)}},
    )

    users.update_one(
        {"_id": _to_object_id(current_user_id)},
        {"$set": {"household_id": household_id}},
    )

    return jsonify({
        "household_id": str(household_id),
        "name": household.get("name"),
        "invite_code": household.get("invite_code"),
    }), 200


@households_bp.get("/me")
@jwt_required()
def my_household():
    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households

    user = users.find_one({"_id": _to_object_id(current_user_id)})
    if not user:
        return jsonify({"error": "user not found"}), 404

    household_id = user.get("household_id")
    if not household_id:
        return jsonify({"household": None}), 200

    household = households.find_one({"_id": household_id})
    if not household:
        return jsonify({"household": None}), 200

    return jsonify({
        "household": {
            "household_id": str(household["_id"]),
            "name": household.get("name"),
            "invite_code": household.get("invite_code"),
            "member_count": len(household.get("members", [])),
        }
    }), 200