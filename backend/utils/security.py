import bcrypt

def hash_password(password: str) -> str:
    # bcrypt salt is generated per password
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")

def verify_password(pasaword: str, hashed: str) -> bool:
    return bcrypt.checkpw(pasaword.encode("utf-8"), hashed.encode("utf-8"))
