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
    
    from routes.health import health_bp
    from routes.auth import auth_bp
    from routes.households import households_bp
    
    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(households_bp)
    
    return app