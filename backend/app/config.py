import os

class Config:
    MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017/housemate')
    SECRET_KEY = os.getenv("JWT_SECRET_KEY","dev-secret-change-me")
    # comma-separated env var -> clean list for flask-cors
    CORS_ORIGINS = [origin.strip() for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:4200,http://127.0.0.1:4200",
    ).split(",") if origin.strip()]
