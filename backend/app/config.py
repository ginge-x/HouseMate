import os

class Config:
    MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017/housemate')
    SECRET_KEY = os.getenv("JWT_SECRET_KEY","dev-secret-change-me")
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:4200")