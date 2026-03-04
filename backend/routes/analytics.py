from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime, date, timedelta
from app.extensions import mongo
from routes.helpers import _get_user_and_household
from routes.helpers import _round2
from routes.helpers import _to_object_id
from routes.helpers import _user_email_lookup

analytics_bp = Blueprint("analytics", __name__, url_prefix="/analytics")

def _parse_date_ymd(s: str):
    if not s:
        return None
    try:
        d = date.fromisoformat(s)
        return datetime(d.year, d.month, d.day)
    except Exception:
        return None
    
@analytics_bp.get("/spending")
@jwt_required()
def spending():
    current_user_id = get_jwt_identity()
    current_user_oid = _to_object_id(current_user_id)
    if not current_user_oid:
        return jsonify({"error": "invalid user id"}), 400
    
    user, household, err = _get_user_and_household(current_user_id)
    if err:
        return err
    
    status = (request.args.get("status") or "all").strip().lower()
    date_field = (request.args.get("date_field") or "created_at").strip()
    
    if date_field not in ("created_at", "due_date"):
        return jsonify({"error": "date_field must be created_at|due_date"}), 400
    
    dt_from = _parse_date_ymd((request.args.get("from") or "").strip())
    dt_to = _parse_date_ymd((request.args.get("to") or "").strip())
    if (request.args.get("from") and not dt_from) or (request.args.get("to") and not dt_to):
        return jsonify({"error": "from/to must be YYYY-MM-DD"}), 400
    
    query = {"household_id": household["_id"]}
    
    if status != "all":
        query["status"] = status
        
    if dt_from or dt_to:
        rng = {}
        if dt_from:
            rng["$gte"] = dt_from
        if dt_to:
            # include whole "to" day by using next-day exclusive bound
            rng["$lt"] = dt_to + timedelta(days=1)
        query[date_field] = rng
        
    bills = list(mongo.db.bills.find(query))
    
    payer_ids = set()
    split_user_ids = set()
    for b in bills:
        if b.get("created_by"):
            payer_ids.add(b["created_by"])
        for s in (b.get("splits") or []):
            if s.get("user_id"):
                split_user_ids.add(s["user_id"])
    email_map = _user_email_lookup(payer_ids | split_user_ids)
    
    total = paid_total = open_total = 0.0
    by_month = {}
    by_payer = {}
    by_share = {}
    
    for b in bills:
        amt = float(b.get("amount", 0) or 0)
        st = (b.get("status") or "open").lower()
        
        total += amt
        if st == "paid":
            paid_total += amt
        else:
            open_total += amt
            
        dt = b.get(date_field) or b.get("created_at") or b.get("due_date")
        if dt:
            key = f"{dt.year:04d}-{dt.month:02d}"
        else:
            key = "unknown"
            
        m = by_month.setdefault(key, {"month": key, "count": 0, "total": 0.0, "paid": 0.0, "open": 0.0})
        m["count"] += 1
        m["total"] += amt
        if st == "paid":
            m["paid"] += amt
        else:
            m["open"] += amt

        payer = b.get("created_by")
        if payer:
            pid = str(payer)
            p = by_payer.setdefault(pid, {"user_id": pid, "email": email_map.get(pid), "count": 0, "total": 0.0})
            p["count"] += 1
            p["total"] += amt

        for s in (b.get("splits") or []):
            uid = s.get("user_id")
            if not uid:
                continue
            uid_str = str(uid)
            owed = float(s.get("amount_owed", 0) or 0)
            is_paid = bool(s.get("paid", False))
            sh = by_share.setdefault(
                uid_str,
                {"user_id": uid_str, "email": email_map.get(uid_str), "bills": set(), "owed": 0.0, "paid": 0.0, "unpaid": 0.0},
            )
            # set avoids double-counting bill ids if data has duplicate split rows
            sh["bills"].add(str(b["_id"]))
            sh["owed"] += owed
            if is_paid:
                sh["paid"] += owed
            else:
                sh["unpaid"] += owed

    by_month_list = list(by_month.values())
    by_month_list.sort(key=lambda x: x["month"])

    for m in by_month_list:
        m["total"] = _round2(m["total"])
        m["paid"] = _round2(m["paid"])
        m["open"] = _round2(m["open"])

    by_payer_list = list(by_payer.values())
    by_payer_list.sort(key=lambda x: x["total"], reverse=True)
    for p in by_payer_list:
        p["total"] = _round2(p["total"])

    by_share_list = []
    for v in by_share.values():
        by_share_list.append(
            {
                "user_id": v["user_id"],
                "email": v["email"],
                "bills_count": len(v["bills"]),
                "owed": _round2(v["owed"]),
                "paid": _round2(v["paid"]),
                "unpaid": _round2(v["unpaid"]),
            }
        )
    by_share_list.sort(key=lambda x: x["owed"], reverse=True)

    return jsonify(
        {
            "from": request.args.get("from") or None,
            "to": request.args.get("to") or None,
            "status": status,
            "date_field": date_field,
            "totals": {
                "count": len(bills),
                "total": _round2(total),
                "paid": _round2(paid_total),
                "open": _round2(open_total),
            },
            "by_month": by_month_list,
            "by_payer": by_payer_list,
            "by_share": by_share_list,
        }
    ), 200
