def init_indexes(mongo):
    # auth + household uniqueness
    mongo.db.users.create_index("email", unique=True)
    mongo.db.households.create_index("invite_code", unique=True)
    # activity and timeline queries
    mongo.db.chat_messages.create_index([("household_id", 1), ("created_at", -1)])
    mongo.db.bills.create_index([("household_id", 1), ("due_date", 1)])
    mongo.db.chores.create_index([("household_id", 1), ("due_date", 1)])
    # dashboard/analytics filters
    mongo.db.bills.create_index([("household_id", 1), ("created_at", -1)])
    mongo.db.bills.create_index([("household_id", 1), ("due_date", -1)])
    mongo.db.bills.create_index([("household_id", 1), ("status", 1)])
