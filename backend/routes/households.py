from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime
import secrets
import string

from app.extensions import mongo
from routes.helpers import _get_user_and_household
from routes.helpers import _is_admin
from routes.helpers import _to_object_id

households_bp = Blueprint("households", __name__, url_prefix="/households")

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
    # retry a few times in rare case of invite code collision
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
        {"$set": {"household_id": household_id, "role":"admin"}},
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
        {"$set": {"household_id": household_id, "role":"member"}},
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
    
@households_bp.get("/members")
@jwt_required()
def houeshold_members():
    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households
    
    user = users.find_one({"_id": _to_object_id(current_user_id)})
    if not user:
        return jsonify({"error" : "user not found"}), 404
    
    household_id = user.get("household_id")
    if not household_id:
        return jsonify({"error" : "user not in a household"}), 400
    
    household = households.find_one({"_id": household_id})
    if not household:
        return jsonify({"error" : "household not found"}), 404
    
    member_ids = household.get("members", [])
    #return minimal safe user info
    members = list(users.find(
        {"_id": {"$in": member_ids}},
        {"password_hash": 0}
    ))
    
    out = []
    for m in members:
        out.append({
            "user_id": str(m["_id"]),
            "email": m.get("email"),
            "role": m.get("role", "member"),
        })
    
    return jsonify({"members" : out}), 200

def _count_admins(household_id) -> int:
    return mongo.db.users.count_documents({"household_id": household_id, "role": "admin"})

@households_bp.post("/leave")
@jwt_required()
def leave_household():
    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    household_id = household["_id"]
    me_id = _to_object_id(current_user_id)
    
    members = household.get("members", [])
    if me_id not in members:
        return jsonify({"error": "not a household member"}), 400
    
    if user.get("role") == "admin":
        admin_count = _count_admins(household_id)
        # prevent orphaning the household with no admins
        if admin_count <= 1 and len(members) > 1:
            return jsonify({"error" : "you are the last admin, promote someone else before leaving the household"}), 400
        
    households.update_one({"_id": household_id}, {"$pull": {"members": me_id}})
    users.update_one({"_id": me_id}, {"$set": {"household_id": None, "role": "member"}})
    
    updated = households.find_one({"_id": household_id}, {"members": 1})
    if updated and len(updated.get("members", [])) == 0:
        # delete empty household once last member leaves
        households.delete_one({"_id": household_id})
        
    return jsonify({"ok": True}), 200

@households_bp.post("/invite-code/rotate")
@jwt_required()
def rotate_invite_code():
    current_user_id = get_jwt_identity()
    households = mongo.db.households
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    if not _is_admin(user):
        return jsonify({"error": "admin only"}), 403
    
    invite_code = None
    # regenerate until unique code is found
    for _ in range(10):
        code = _generate_invite_code()
        if not households.find_one({"invite_code": code}):
            invite_code = code
            break
    
    if not invite_code:
        return jsonify({"error": "failed to generate invite code"}), 500
    
    households.update_one({"_id": household["_id"]}, {"$set": {"invite_code": invite_code}})
    return jsonify({"invite_code": invite_code}), 200


@households_bp.patch("/members/<user_id>/role")
@jwt_required()
def set_member_role(user_id: str):
    current_user_id = get_jwt_identity()
    users = mongo.db.users
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    if not _is_admin(user):
        return jsonify ({"error": "admin only"}), 403
    
    data = request.get_json(force=True) or {}
    role = (data.get("role") or "").strip().lower()
    if role not in ("admin", "member"):
        return jsonify({"error": "role must be admin or member"}), 400
    
    target_id = _to_object_id(user_id)
    if not target_id:
        return jsonify({"error": "invalid user id"}), 400
    
    
    target = users.find_one({"_id": target_id})
    if not target or target.get("household_id") != household["_id"]:
        return jsonify({"error": "target not in household"}), 404
    
    if target.get("role") == "admin" and role == "member":
        admin_count = _count_admins(household["_id"])
        if admin_count <= 1:
            return jsonify({"error": "cannot demote the last admin"}), 400
        
    users.update_one({"_id": target_id}, {"$set": {"role": role}})
    return jsonify({"ok": True}), 200

@households_bp.delete("/members/<user_id>")
@jwt_required()
def remove_member(user_id: str):
    current_user_id = get_jwt_identity()
    users = mongo.db.users
    households = mongo.db.households
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    if not _is_admin(user):
        return jsonify({"error": "admin only"}), 403
    
    target_id = _to_object_id(user_id)
    if not target_id:
        return jsonify({"error": "invalid user id"}), 400

    me_id = _to_object_id(current_user_id)
    if target_id == me_id:
        return jsonify({"error": "use /leave to remove yourself"}), 400
    
    target = users.find_one({"_id": target_id})
    if not target or target.get("household_id") != household["_id"]:
        return jsonify({"error": "target not in household"}), 404
    
    if target.get("role") == "admin":
        admin_count = _count_admins(household["_id"])
        if admin_count <= 1 and len(household.get("members", [])) > 1:
            return jsonify({"error": "cannot remove the last admin"}), 400
        
    households.update_one({"_id": household["_id"]}, {"$pull": {"members": target_id}})
    users.update_one({"_id": target_id}, {"$set": {"household_id": None, "role": "member"}})
    
    return jsonify({"ok": True}), 200
