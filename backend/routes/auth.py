from flask import Blueprint, request, jsonify
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity
from app.extensions import mongo
from utils.security import hash_password, verify_password

auth_bp = Blueprint('auth', __name__)

@auth_bp.post("/register")
def register():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    
    if not email or not password:
        return {"error": "email and password required"}, 400

    users = mongo.db.users
    if users.find_one({"email" : email}):
        return {"error": "email already registered to an account"}, 400
    
    user_doc = {
        "email": email,
        "password_hash": hash_password(password),
        "household_id": None,
        "role": "member"
    }
    result = users.insert_one(user_doc)
    token = create_access_token(identity=str(result.inserted_id))
    return {"access_token": token}, 201

@auth_bp.post("/login")
def login():
    data = request.get_json(force=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    
    users = mongo.db.users
    user = users.find_one({"email" : email})
    if not user or not verify_password(password, user["password_hash"]):
        return {"error" : "invalid credentials"}, 401
    
    token = create_access_token(identity=str(user["_id"]))
    return jsonify({"access_token" : token}), 200

@auth_bp.get("/me")
@jwt_required()
def me():
    user_id = get_jwt_identity()
    user = mongo.db.users.find_one({"_id": _to_object_id(user_id)}, {"password_hash": 0})
    if not user:
        return {"error": "user not found"}, 404
    
    user["_id"] = str(user["_id"])
    if user.get("household_id"):
        user["household_id"] = str(user["household_id"])

    return user, 200

def _to_object_id(value: str):
    from bson import ObjectId
    return ObjectId(value)
    #helper to avoid bson import in all files