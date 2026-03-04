from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime
from bson import ObjectId

from app.extensions import mongo
from routes.helpers import _get_user_and_household
from routes.helpers import _is_admin
from routes.helpers import _to_object_id
from routes.helpers import _user_email_lookup

requests_bp = Blueprint("requests", __name__, url_prefix="/requests")

def _request_to_json(req_doc, current_user_id: str, email_lookup: dict):
    creator_id = req_doc.get("created_by")
    creator_id_str = str(creator_id) if creator_id else None
    
    # resolve permissions per caller for can_edit/can_delete flags
    is_admin = _is_admin(mongo.db.users.find_one({"_id": _to_object_id(current_user_id)}, {"role": 1}))
    is_creator = creator_id_str == current_user_id
    
    comments = req_doc.get("comments", [])
    return{
        "request_id": str(req_doc["_id"]),
        "household_id": str(req_doc["household_id"]),
        "title": req_doc.get("title"),
        "body": req_doc.get("body"),
        "status": req_doc.get("status", "open"),
        "created_by": creator_id_str,
        "created_by_email": email_lookup.get(creator_id_str),
        "created_at": req_doc.get("created_at").isoformat() if req_doc.get("created_at") else None,
        "updated_at": req_doc.get("updated_at").isoformat() if req_doc.get("updated_at") else None,
        "comment_count": len(comments),
        "can_edit": bool(is_admin or is_creator),
        "can_delete": bool(is_admin or is_creator),
    }
    
@requests_bp.post("")
@jwt_required()
def create_request():
    data = request.get_json(force=True) or {}
    title = (data.get("title") or "").strip()
    body = (data.get("body") or "").strip()
    
    if not title:
        return jsonify({"error": "title is required"}), 400
    if not body:
        return jsonify({"error": "body is required"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = {
        "household_id": household["_id"],
        "title": title,
        "body": body,
        "status": "open",
        "created_by": current_user_oid,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
        "comments": [],
    }
    
    res = mongo.db.requests.insert_one(doc)
    created = mongo.db.requests.find_one({"_id": res.inserted_id})
    
    email_lookup = _user_email_lookup({created["created_by"]})
    return jsonify({"request": _request_to_json(created, current_user_id, email_lookup)}), 201

@requests_bp.get("")
@jwt_required()
def list_requests():
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    status = (request.args.get("status") or "all").strip().lower()
    q = {"household_id": household["_id"]}
    if status in ("open", "done"):
        # "all" means no status filter
        q["status"] = status
        
    docs = list(mongo.db.requests.find(q).sort([("created_at", -1)]))
    
    creator_ids = {d.get("created_by") for d in docs if d.get("created_by")}
    email_lookup = _user_email_lookup(creator_ids)
    
    out = [_request_to_json(d, current_user_id, email_lookup) for d in docs]
    return jsonify({"requests": out}), 200

@requests_bp.get("/<request_id>")
@jwt_required()
def get_request(request_id: str):
    rid = _to_object_id(request_id)
    if not rid:
        return jsonify({"error": "invalid request id"}), 400
    
    current_user_id = get_jwt_identity()
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = mongo.db.requests.find_one({"_id": rid, "household_id": household["_id"]})
    if not doc:
        return jsonify({"error": "request not found"}), 404
    
    # email lookup for creator + commenters in one query
    commenters_ids = {c.get("user_id") for c in doc.get("comments", []) if c.get("user_id")}
    creator_ids = {doc.get("created_by")} if doc.get("created_by") else set()
    email_lookup = _user_email_lookup(creator_ids | commenters_ids)
    
    base = _request_to_json(doc, current_user_id, email_lookup)
    
    is_admin = _is_admin(user)
    comments_out = []
    for c in doc.get("comments", []):
        cid = c.get("_id")
        uid = c.get("user_id")
        uid_str = str(uid) if uid else None
        comments_out.append({
            "comment_id": str(cid) if cid else None,
            "user_id": uid_str,
            "email": email_lookup.get(uid_str),
            "body": c.get("body"),
            "created_at": c.get("created_at").isoformat() if c.get("created_at") else None,
            "can_delete": bool(is_admin or uid_str == current_user_id),
        })
        
    return jsonify({"request": {**base, "comments": comments_out}}), 200

@requests_bp.patch("/<request_id>")
@jwt_required()
def update_request(request_id: str):
    rid = _to_object_id(request_id)
    if not rid:
        return jsonify({"error": "invalid request id"}), 400
    
    data = request.get_json(force=True) or {}
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = mongo.db.requests.find_one({"_id": rid, "household_id": household["_id"]})
    if not doc:
        return jsonify({"error": "requset not found"}), 404
    
    is_admin = _is_admin(user)
    is_creator = doc.get("created_by") == current_user_oid
    # only creator or admin can edit request body/status
    if not (is_admin or is_creator):
        return jsonify({"error": "not allowed"}), 403
    
    updates = {}
    
    if "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "title cannot be empty"}), 400
        updates["title"] = title
    
    if "body" in data:
        body = (data.get("body") or "").strip()
        if not body:
            return jsonify({"error": "body cannot be empty"}), 400
        updates["body"] = body
        
    if "status" in data:
        status = (data.get("status") or "").strip().lower()
        if status not in ("open", "done"):
            return jsonify({"error": "status must be open or done"}), 400
        updates["status"] = status
        
    if not updates:
        return jsonify({"error": "no valid fields to update"}), 400
    
    updates["updated_at"] = datetime.utcnow()
    mongo.db.requests.update_one({"_id": rid}, {"$set": updates})
    
    updated = mongo.db.requests.find_one({"_id": rid})
    email_lookup = _user_email_lookup({updated.get("created_by")} if updated.get("created_by") else set())
    return jsonify({"request": _request_to_json(updated, current_user_id, email_lookup)}), 200

@requests_bp.delete("/<request_id>")
@jwt_required()
def delete_request(request_id: str):
    rid = _to_object_id(request_id)
    if not rid:
        return jsonify({"error": "invalid request id"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = mongo.db.requests.find_one({"_id": rid, "household_id": household["_id"]})
    if not doc:
        return jsonify({"error": "request not found"}), 404
    
    is_admin = _is_admin(user)
    is_creator = doc.get("created_by") == current_user_oid
    if not (is_admin or is_creator):
        return jsonify({"error": "not allowed"}), 403
    
    mongo.db.requests.delete_one({"_id": rid})
    return jsonify({"ok": True}), 200

@requests_bp.post("/<request_id>/comments")
@jwt_required()
def add_comment(request_id: str):
    rid = _to_object_id(request_id)
    if not rid:
        return jsonify({"error": "invalid request id"}), 400
    
    data = request.get_json(force=True) or {}
    body = (data.get("body") or "").strip()
    if not body:
        return jsonify({"error": "body is required"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = mongo.db.requests.find_one({"_id": rid, "household_id": household["_id"]})
    if not doc:
        return jsonify({"error": "request not found"}), 404
    
    comment = {
        "_id": ObjectId(),
        "user_id": current_user_oid,
        "body": body,
        "created_at": datetime.utcnow(),
    }
    
    mongo.db.requests.update_one(
        {"_id": rid},
        {"$push": {"comments": comment}, "$set": {"updated_at": datetime.utcnow()}},
    )
    
    return jsonify({"ok": True, "comment_id": str(comment["_id"])}), 201

@requests_bp.delete("/<request_id>/comments/<comment_id>")
@jwt_required()
def delete_comment(request_id: str, comment_id: str):
    rid = _to_object_id(request_id)
    cid = _to_object_id(comment_id)
    if not rid or not cid:
        return jsonify({"error": "invalid request/comment id"}), 400
    
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    doc = mongo.db.requests.find_one({"_id": rid, "household_id": household["_id"]})
    if not doc:
        return jsonify({"error": "request not found"}), 404
    
    is_admin = _is_admin(user)

    comment_owner = None
    # find owner before enforcing delete permission
    for c in doc.get("comments", []):
        if c.get("_id") == cid:
            comment_owner = c.get("user_id")
            break
        
    if comment_owner is None:
        return jsonify({"error": "comment not found"}), 404
    
    if not (is_admin or comment_owner == current_user_oid):
        return jsonify({"error": "not allowed - invalid permissions"}), 403
    
    mongo.db.requests.update_one(
        {"_id": rid},
        {"$pull": {"comments": {"_id": cid}}, "$set": {"updated_at": datetime.utcnow()}},
    )
    
    return jsonify({"ok": True}), 200
