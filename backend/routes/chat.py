from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime, timezone
from app.extensions import mongo
from routes.helpers import _get_user_and_household
from routes.helpers import _to_object_id
from routes.helpers import _user_email_lookup

chat_bp = Blueprint("chat", __name__, url_prefix="/chat")

def _parse_iso_datetime(value: str):
    if not value:
        return None
    try:
        v = value.strip()
        if v.endswith("Z"):
            # normalize zulu format to python offset format
            v = v[:-1] + "+00:00"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is not None:
            # store/compare as naive utc in mongodb
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None
    
@chat_bp.get("/messages")
@jwt_required()
def list_messages():
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    after = _parse_iso_datetime(request.args.get("after") or "")
    limit_raw = request.args.get("limit")
    
    try:
        limit = int(limit_raw) if limit_raw is not None else 50
    except ValueError:
        return jsonify({"error": "limit must be an integer"}), 400
    
    limit = max(1, min(limit, 100))
    
    q = {"household_id": household["_id"]}
    if after:
        q["created_at"] = {"$gt": after}
        
    docs = list(
        mongo.db.chat_messages
        .find(q)
        .sort([("created_at", -1)])
        .limit(limit)
    )
    # fetch newest first for index usage, then return oldest->newest for ui
    docs.reverse()
    
    sender_ids = {d.get("user_id") for d in docs if d.get("user_id")}
    email_map = _user_email_lookup(sender_ids)
    
    out = []
    for d in docs:
        uid = d.get("user_id")
        uid_str = str(uid) if uid else None
        out.append({
            "message_id": str(d["_id"]),
            "user_id": uid_str,
            "email": email_map.get(uid_str),
            "is_you": bool(uid == current_user_oid),
            "text": d.get("text", ""),
            "created_at": d.get("created_at").isoformat() if d.get("created_at") else None,
        })
    
    return jsonify({"messages": out}), 200

@chat_bp.post("/messages")
@jwt_required()
def send_message():
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    
    if not text:
        return jsonify({"error": "text is required"}), 400
    if len(text) > 500:
        return jsonify({"error": "text must be 500 characters or less"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = {
        "household_id": household["_id"],
        "user_id": current_user_oid,
        "text": text,
        "created_at": datetime.utcnow(),
    }
    
    res = mongo.db.chat_messages.insert_one(doc)
    created = mongo.db.chat_messages.find_one({"_id": res.inserted_id})
    
    return jsonify({
        "message": {
            "message_id": str(created["_id"]),
            "user_id": str(created["user_id"]),
            "email": user.get("email"),
            "is_you": True,
            "text": created.get("text", ""),
            "created_at": created.get("created_at").isoformat() if created.get("created_at") else None,
        }
    }), 201
