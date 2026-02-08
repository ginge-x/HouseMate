from flask import Blueprint

health_bp = Blueprint('health', __name__)

@health_bp.get("/")
def root():
    return {"status" : "ok", "service" : "HouseMate API"}, 200 

@health_bp.get('/health')
def health():
    return {"status": "ok"}