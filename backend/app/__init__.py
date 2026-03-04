from flask import Flask
from dotenv import load_dotenv
from .config import Config
from .extensions import mongo, jwt, cors

def create_app():
    load_dotenv()
    app = Flask(__name__)
    app.config.from_object(Config)
    
    mongo.init_app(app)
    jwt.init_app(app)
    cors.init_app(app, resources={r"/*" : {"origins" : app.config["CORS_ORIGINS"]}})
    
    from .db_setup import init_indexes
    # ensure indexes exist at startup for predictable query performance
    init_indexes(mongo)
    
    from routes.auth import auth_bp
    from routes.households import households_bp
    from routes.bills import bills_bp
    from routes.chores import chores_bp
    from routes.requests import requests_bp
    from routes.chat import chat_bp
    from routes.reminders import reminders_bp
    from routes.analytics import analytics_bp
    
    app.register_blueprint(auth_bp)
    app.register_blueprint(households_bp)
    app.register_blueprint(bills_bp)
    app.register_blueprint(chores_bp)
    app.register_blueprint(requests_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(reminders_bp)
    app.register_blueprint(analytics_bp)
    
    return app
