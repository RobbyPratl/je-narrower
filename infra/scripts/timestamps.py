# Timestamp synthesis. Documented, not hidden.
#
#   docker exec erpnext-backend-1 bash -c \
#     'cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py timestamps main'
#
# Every document in this dataset was generated in one sitting, so the raw
# `creation` values all cluster in a few minutes of real time and carry no
# information. This step rewrites `creation`/`modified` on the voucher tables and
# on tabGL Entry so that WHEN a document was entered is consistent with WHAT it
# is.
#
# Assignment is BY ROLE, uniformly — never per-entry hand-placement:
#
#   ar.clerk / ap.clerk   business hours (08:00-18:30), weekdays only
#   controller            slightly wider window (07:30-19:30), weekdays only
#   batch.bot             01:00-04:00 on the day AFTER the posting date, which
#                         lands a share of the month-end batches on weekends
#                         (exactly the automation-posts-overnight effect the
#                         scope doc expects the off-hours rule to fire on)
#
# Plus one deliberate, documented texture: ~5% of clerk-entered invoices are
# entered 2-10 days AFTER their posting date (late entry / backdating texture for
# the date-mismatch rule).
#
# Deterministic: every value is a pure function of (voucher name, posting_date,
# owner), so this is idempotent — rerunning produces byte-identical timestamps.
# It touches only WHEN, never which accounts pair, which amounts post, or which
# entries score.

import hashlib
from datetime import date, datetime, timedelta

import frappe

COMPANY = "Meridian Trading Co."
BOT_USER = "batch.bot@meridian.example"
CTRL_USER = "controller@meridian.example"

VOUCHER_TABLES = {
    "Sales Invoice": ["Sales Invoice Item", "Sales Taxes and Charges"],
    "Purchase Invoice": ["Purchase Invoice Item", "Purchase Taxes and Charges"],
    "Payment Entry": ["Payment Entry Reference", "Payment Entry Deduction"],
    "Journal Entry": ["Journal Entry Account"],
}

LATE_ENTRY_RATE = 0.05  # share of clerk invoices entered after the posting date


def _h(*parts):
    """Stable 64-bit hash of the inputs — hashlib, not hash(), because Python's
    string hash is salted per process and would break determinism."""
    return int(hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:16], 16)


def _next_weekday(d):
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def synth(name, posting_date, owner, doctype):
    """(voucher, posting_date, owner) -> creation datetime. Pure function."""
    if isinstance(posting_date, datetime):
        posting_date = posting_date.date()
    h = _h(name, posting_date, owner)

    if owner == BOT_USER:
        # automated batch: overnight window on the day after the posting date
        d = posting_date + timedelta(days=1)
        hour = 1 + (h % 3)                       # 01, 02, 03
        minute = (h >> 4) % 60
        second = (h >> 10) % 60
    else:
        d = posting_date
        # ~5% of clerk-entered invoices are entered days after the posting date
        if doctype in ("Sales Invoice", "Purchase Invoice") and (h >> 40) % 100 < LATE_ENTRY_RATE * 100:
            d = d + timedelta(days=2 + (h >> 46) % 9)
        d = _next_weekday(d)
        if owner == CTRL_USER:
            start_min, span = 7 * 60 + 30, 12 * 60      # 07:30 - 19:30
        else:
            start_min, span = 8 * 60, 10 * 60 + 30      # 08:00 - 18:30
        m = start_min + (h % span)
        hour, minute = divmod(m, 60)
        second = (h >> 10) % 60

    micro = (h >> 20) % 1000000
    return datetime(d.year, d.month, d.day, hour, minute, second, micro)


def main():
    frappe.set_user("Administrator")
    stamps = {}   # voucher name -> creation datetime

    for doctype, children in VOUCHER_TABLES.items():
        rows = frappe.db.sql(
            f"SELECT name, posting_date, owner FROM `tab{doctype}` "
            f"WHERE docstatus = 1", as_dict=True)
        n = 0
        for r in rows:
            created = synth(r.name, r.posting_date, r.owner, doctype)
            stamps[r.name] = created
            modified = created + timedelta(seconds=1 + (_h(r.name, "m") % 240))
            frappe.db.sql(
                f"UPDATE `tab{doctype}` SET creation=%s, modified=%s WHERE name=%s",
                (created, modified, r.name))
            n += 1
        # child rows inherit the parent's timestamps
        for child in children:
            try:
                frappe.db.sql(f"""
                    UPDATE `tab{child}` c JOIN `tab{doctype}` p ON p.name = c.parent
                    SET c.creation = p.creation, c.modified = p.modified
                    WHERE c.parenttype = %s""", (doctype,))
            except Exception as e:
                print("  child skip", child, type(e).__name__)
        print(f"  {doctype}: {n} vouchers restamped")

    # GL Entry rows are written when the voucher is submitted, so they carry the
    # voucher's timestamp.
    gl = frappe.db.sql(
        "SELECT name, voucher_no FROM `tabGL Entry` WHERE is_cancelled = 0", as_dict=True)
    missing = 0
    for r in gl:
        created = stamps.get(r.voucher_no)
        if not created:
            missing += 1
            continue
        modified = created + timedelta(seconds=1 + (_h(r.voucher_no, "m") % 240))
        frappe.db.sql("UPDATE `tabGL Entry` SET creation=%s, modified=%s WHERE name=%s",
                      (created, modified, r.name))
    frappe.db.commit()
    print(f"  GL Entry: {len(gl) - missing} rows restamped, {missing} unmatched")
    verify()


def verify():
    frappe.set_user("Administrator")
    print("== creation-hour distribution by owner (GL Entry, main company) ==")
    for r in frappe.db.sql("""
        SELECT owner,
               SUM(HOUR(creation) BETWEEN 7 AND 19) business_hours,
               SUM(HOUR(creation) < 7 OR HOUR(creation) > 19) off_hours,
               SUM(DAYOFWEEK(creation) IN (1,7)) weekend,
               COUNT(*) total
        FROM `tabGL Entry` WHERE company=%s AND is_cancelled=0
        GROUP BY owner""", (COMPANY,), as_dict=True):
        print(f"  {r.owner:32s} business={int(r.business_hours):5d} "
              f"off_hours={int(r.off_hours):5d} weekend={int(r.weekend):5d} "
              f"total={int(r.total):5d}")
    late = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabGL Entry`
        WHERE company=%s AND is_cancelled=0 AND DATEDIFF(DATE(creation), posting_date) >= 2
        """, (COMPANY,))[0][0]
    tot = frappe.db.count("GL Entry", {"company": COMPANY, "is_cancelled": 0})
    print(f"  creation >= 2 days after posting_date: {late} / {tot} rows")
    print("  creation range:", frappe.db.sql(
        "SELECT MIN(creation), MAX(creation) FROM `tabGL Entry` WHERE company=%s", (COMPANY,)))
