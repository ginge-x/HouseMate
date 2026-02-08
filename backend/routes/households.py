from flask import Blueprint
from flask_jwt_extended import jwt_required

households_bp = Blueprint("households", __name__)

@households_bp.get("/ping")
@jwt_required()
def ping():
    return {"message" : "households route ok"}