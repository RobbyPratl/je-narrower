# Transaction driver for the JE population testing demo.
#
#   docker exec erpnext-backend-1 bash -c \
#     'cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py drive run P1'
#
# Deterministic: seeded RNG per (period, month), so a rerun of a month produces
# the same business activity. Resumable: a month already at target invoice count
# is skipped, so a crash mid-year can be restarted without double-posting.
#
# This module decides WHAT BUSINESS ACTIVITY HAPPENS. Which account pairs result
# is decided entirely by ERPNext's posting logic — no pairing is placed by hand,
# and no anomaly is planted.

import calendar
import random
import traceback
from datetime import date, timedelta

import frappe

COMPANY = "Meridian Trading Co."
ABBR = "MTC"
SUB_COMPANY = "Meridian Logistics LLC"
YEAR = 2025

AR_USER = "ar.clerk@meridian.example"
AP_USER = "ap.clerk@meridian.example"
CTRL_USER = "controller@meridian.example"
BOT_USER = "batch.bot@meridian.example"

PERIODS = {"P1": (1, 6), "P2": (7, 12)}

# Resolved at runtime by check_accounts()
ACCT = {}
CC = {}

CUSTOMERS = [
    "Northwind Retail", "Cascade Outfitters", "Bluepine Hardware", "Juniper & Co",
    "Halstrom Supply", "Redcedar Builders", "Marlowe Interiors", "Pactrail Sports",
    "Ovation Events", "Kestrel Foods", "Brightline Offices", "Summit Rentals",
    "Ferrous Works", "Galehouse Media", "Timberline Schools",
]
# Sales-tax exempt customers (schools / non-profits) — some invoices carry no tax row.
TAX_EXEMPT = {"Timberline Schools", "Ovation Events"}

# (item, weight in P1, weight in P2)
# Premium Widget roughly doubles in P2 (deliberate SHIFTED volume change).
SALE_ITEMS = [
    ("Standard Widget", 10, 9),
    ("Premium Widget", 4, 9),
    ("Widget Mounting Kit", 6, 6),
    ("Industrial Fastener Pack", 5, 5),
    ("Sealant Cartridge", 7, 6),
    ("Anchor Bolt Set", 5, 5),
    ("Site Survey", 2, 2),
    ("Freight & Handling", 4, 4),
    ("Maintenance Plan - Annual", 1, 1),
    ("Custom Fabrication", 2, 2),
]

# P2-only revenue line, sales begin in August.
INSTALL_ITEMS = [("Installation - Standard", 5), ("Installation - Complex", 2)]

# Item -> (income account_name, cost centre key). Different income accounts and
# cost centres are what give multi-item invoices multi-row GL vouchers, since
# ERPNext merges GL rows on (account, cost_center, party, ...).
ITEM_POSTING = {
    # widget family is fulfilled from the sales floor, the hardware family from
    # the warehouse — so an invoice mixing families posts two Sales GL rows
    "Standard Widget": ("Sales", "sales"),
    "Premium Widget": ("Sales", "sales"),
    "Widget Mounting Kit": ("Sales", "sales"),
    "Industrial Fastener Pack": ("Sales", "warehouse"),
    "Sealant Cartridge": ("Sales", "warehouse"),
    "Anchor Bolt Set": ("Sales", "warehouse"),
    "Site Survey": ("Service", "sales"),
    "Maintenance Plan - Annual": ("Service", "admin"),
    "Custom Fabrication": ("Service", "warehouse"),
    "Freight & Handling": ("Freight Income", "admin"),
    "Installation - Standard": ("Installation Revenue", "sales"),
    "Installation - Complex": ("Installation Revenue", "sales"),
}

# supplier -> (expense account_name, monthly PI count P1, monthly PI count P2)
SUPPLIERS = {
    "Orchard Wholesale":         ("Cost of Goods Sold", 8, 3),   # SHIFTED: volume drops
    "Vulcan Materials Co":       ("Cost of Goods Sold", 5, 5),
    "Beacon Freight":            ("Freight and Forwarding Charges", 4, 4),
    "Cobalt IT Services":        ("IT and Software Expenses", 2, 2),
    "Stateside Insurance":       ("Insurance Expense", 1, 1),
    "Metro Utilities":           ("Utility Expenses", 2, 2),
    "Harlan Office Supply":      ("Office Maintenance Expenses", 2, 2),
    "Quill Marketing Group":     ("Marketing Expenses", 2, 3),
    "Ironclad Security":         ("Security Expenses", 1, 1),
    "Fairbanks Consulting":      ("Contractor Services", 3, 0),   # VANISHED after June
    "Sterling Equipment Leasing": ("Equipment Lease Expense", 0, 2),  # NEW in P2
    "Granite Janitorial":        ("Office Maintenance Expenses", 1, 1),
}

# Secondary expense accounts a supplier occasionally also bills, so some purchase
# invoices carry two or three expense lines instead of one.
SECONDARY_EXPENSE = [
    "Print and Stationery", "Postal Expenses", "Telephone Expenses",
    "Travel Expenses", "Office Rent", "Entertainment Expenses",
]


# --------------------------------------------------------------------------
# resolution / helpers
# --------------------------------------------------------------------------

def acct(account_name, company=COMPANY):
    name = frappe.db.get_value(
        "Account", {"company": company, "account_name": account_name, "is_group": 0}, "name")
    if not name:
        raise Exception(f"Account not found: {account_name!r} in {company!r}")
    return name


def check_accounts():
    company = frappe.get_doc("Company", COMPANY)
    ACCT.update({
        "debtors": company.default_receivable_account,
        "creditors": company.default_payable_account,
        "bank": company.default_bank_account or acct("Primary Checking"),
        "cash": company.default_cash_account or acct("Cash"),
        "install_rev": acct("Installation Revenue"),
        "ic_receivable": acct("Intercompany Receivable"),
        "salaries": acct("Salary"),
        "payroll_pay": acct("Payroll Payable"),
        "tax_wh": acct("Tax Withholding Payable"),
        "acc_dep": acct("Accumulated Depreciation"),
        "dep_exp": acct("Depreciation"),
        "sales": acct("Sales"),
        "service": acct("Service"),
        "freight_inc": acct("Freight Income"),
        "misc": acct("Miscellaneous Expenses"),
        "utilities": acct("Utility Expenses"),
        "prepaid": acct("Prepaid Expenses"),
        "insurance": acct("Insurance Expense"),
        "accrued": acct("Accrued Expenses"),
    })
    for key, val in ACCT.items():
        if not val or not frappe.db.exists("Account", val):
            raise Exception(f"Missing account for {key}: {val}")
    for _s, (exp, _a, _b) in SUPPLIERS.items():
        acct(exp)
    for e in SECONDARY_EXPENSE:
        acct(e)

    for key, cc_name in [("sales", "Sales Ops"), ("warehouse", "Warehouse"), ("admin", "Admin")]:
        CC[key] = frappe.db.get_value(
            "Cost Center", {"company": COMPANY, "cost_center_name": cc_name}, "name")
        if not CC[key]:
            raise Exception(f"Missing cost center {cc_name}")

    # subsidiary accounts for the mirrored intercompany JE
    ACCT["sub_ic_payable"] = acct("Intercompany Payable", company=SUB_COMPANY)
    ACCT["sub_mgmt_fee"] = acct("Management Fee Expense", company=SUB_COMPANY)
    ACCT["sub_cc"] = frappe.db.get_value(
        "Cost Center", {"company": SUB_COMPANY, "is_group": 0}, "name", order_by="lft")
    print("ACCOUNTS_OK bank=%s debtors=%s creditors=%s" %
          (ACCT["bank"], ACCT["debtors"], ACCT["creditors"]))


def weekdays_in_month(month):
    last = calendar.monthrange(YEAR, month)[1]
    return [date(YEAR, month, d) for d in range(1, last + 1)
            if date(YEAR, month, d).weekday() < 5]


def _submit(doc):
    doc.flags.ignore_permissions = True
    doc.submit()
    return doc


# --------------------------------------------------------------------------
# document builders
# --------------------------------------------------------------------------

def pick_items(rng, period_key):
    """1-5 distinct line items. Amounts are qty x jittered price — multiplicative,
    so the leading-digit distribution emerges rather than being sampled."""
    widx = 1 if period_key == "P1" else 2
    n = rng.choices([1, 2, 3, 4, 5, 6], weights=[18, 24, 24, 18, 11, 5])[0]
    pool = [it for it, *_ in SALE_ITEMS]
    weights = [row[widx] for row in SALE_ITEMS]
    chosen, seen = [], set()
    for _ in range(n):
        it = rng.choices(pool, weights=weights)[0]
        if it in seen:
            continue
        seen.add(it)
        std = float(frappe.db.get_value("Item", it, "standard_rate"))
        qty = rng.randint(1, 24)
        rate = round(std * rng.uniform(0.92, 1.12), 2)
        chosen.append((it, qty, rate))
    return chosen


def make_si(rng, day, customer, items, user=AR_USER, with_tax=True):
    frappe.set_user(user)
    rows = []
    for (it, qty, rate) in items:
        income_name, cc_key = ITEM_POSTING[it]
        rows.append({
            "item_code": it, "qty": qty, "rate": rate,
            "income_account": acct(income_name),
            "cost_center": CC[cc_key],
        })
    doc = {
        "doctype": "Sales Invoice",
        "naming_series": "ACC-SINV-2025-.#####",
        "company": COMPANY,
        "customer": customer,
        "set_posting_time": 1,
        "posting_date": str(day),
        "due_date": str(day + timedelta(days=30)),
        "currency": "USD", "conversion_rate": 1.0,
        "selling_price_list": "Standard Selling",
        "price_list_currency": "USD", "plc_conversion_rate": 1.0,
        "items": rows,
        "remarks": f"Customer order {customer} {day:%b %Y}",
    }
    if with_tax and customer not in TAX_EXEMPT:
        doc["taxes"] = [{
            "charge_type": "On Net Total",
            "account_head": acct("ST 6%"),
            "description": "State Sales Tax 6%",
            "rate": 6.0,
            "cost_center": CC["admin"],
        }]
    si = frappe.get_doc(doc)
    si.insert(ignore_permissions=True)
    return _submit(si)


def make_pi(rng, day, supplier, expense_account, amount, user=AP_USER, cost_center=None):
    frappe.set_user(user)
    cc = cost_center or CC["admin"]
    rows = [{
        "item_name": f"{supplier} billing",
        "description": f"{supplier} - {day:%B %Y} billing",
        "qty": 1, "rate": amount, "uom": "Nos", "conversion_factor": 1,
        "expense_account": expense_account, "cost_center": cc,
    }]
    # ~32% of purchase invoices carry a second/third expense line
    if rng.random() < 0.32:
        for _ in range(rng.choice([1, 1, 2])):
            sec = rng.choice(SECONDARY_EXPENSE)
            rows.append({
                "item_name": f"{sec} recharge",
                "description": f"{supplier} - {sec}",
                "qty": 1, "rate": round(rng.uniform(60, 2400), 2),
                "uom": "Nos", "conversion_factor": 1,
                "expense_account": acct(sec), "cost_center": CC["admin"],
            })
    pi = frappe.get_doc({
        "doctype": "Purchase Invoice",
        "naming_series": "ACC-PINV-2025-.#####",
        "company": COMPANY,
        "supplier": supplier,
        "currency": "USD", "conversion_rate": 1.0,
        "buying_price_list": "Standard Buying",
        "price_list_currency": "USD", "plc_conversion_rate": 1.0,
        "set_posting_time": 1,
        "posting_date": str(day),
        "bill_no": f"INV-{supplier[:3].upper()}-{day:%y%m}-{rng.randint(100, 999)}",
        "bill_date": str(day),
        "due_date": str(day + timedelta(days=30)),
        "items": rows,
        "remarks": f"{supplier} {day:%B %Y} billing",
    })
    pi.insert(ignore_permissions=True)
    return _submit(pi)


def make_credit_note(rng, si, day, user=AR_USER):
    """Customer return: a negative-quantity Sales Invoice against the original."""
    frappe.set_user(user)
    src = frappe.get_doc("Sales Invoice", si.name)
    row = src.items[rng.randrange(len(src.items))]
    qty = max(1, int(abs(row.qty) * rng.uniform(0.2, 0.6)))
    cn = frappe.get_doc({
        "doctype": "Sales Invoice",
        "naming_series": "ACC-SINV-2025-.#####",
        "company": COMPANY,
        "customer": src.customer,
        "is_return": 1,
        "return_against": src.name,
        "set_posting_time": 1,
        "posting_date": str(day),
        "currency": "USD", "conversion_rate": 1.0,
        "selling_price_list": "Standard Selling",
        "price_list_currency": "USD", "plc_conversion_rate": 1.0,
        "items": [{
            "item_code": row.item_code, "qty": -qty, "rate": row.rate,
            "income_account": row.income_account, "cost_center": row.cost_center,
            "sales_invoice_item": row.name,
        }],
        "remarks": f"Return against {src.name}",
    })
    cn.insert(ignore_permissions=True)
    return _submit(cn)


def pay_invoice(rng, inv, day, user, fraction=None):
    """Pay an invoice. fraction < 1 makes it a partial payment."""
    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
    frappe.set_user(user)
    party_amount = None
    if fraction and fraction < 1:
        party_amount = round(float(inv.grand_total) * fraction, 2)
    pe = get_payment_entry(inv.doctype, inv.name, bank_account=ACCT["bank"],
                           party_amount=party_amount)
    pe.naming_series = "ACC-PAY-2025-.#####"
    pe.posting_date = str(day)
    pe.reference_no = f"ACH-{inv.name[-8:]}"
    pe.reference_date = str(day)
    pe.mode_of_payment = "Wire Transfer" if frappe.db.exists(
        "Mode of Payment", "Wire Transfer") else None
    pe.remarks = f"Payment against {inv.name}"
    pe.insert(ignore_permissions=True)
    return _submit(pe)


def make_je(day, lines, user, remark, company=COMPANY, voucher_type="Journal Entry",
            reference_no=None):
    frappe.set_user(user)
    doc = {
        "doctype": "Journal Entry",
        "naming_series": "ACC-JV-2025-.#####",
        "voucher_type": voucher_type,
        "company": company,
        "posting_date": str(day),
        "accounts": lines,
        "user_remark": remark,
    }
    # ERPNext requires a cheque reference on Bank/Cash-style entries
    if voucher_type in ("Bank Entry", "Cash Entry", "Credit Card Entry", "Contra Entry"):
        doc["cheque_no"] = reference_no or f"REF-{day:%Y%m%d}"
        doc["cheque_date"] = str(day)
    je = frappe.get_doc(doc)
    je.insert(ignore_permissions=True)
    return _submit(je)


# --------------------------------------------------------------------------
# month-end batches
# --------------------------------------------------------------------------

def month_payroll(rng, month):
    """Payroll posts as a journal entry by batch.bot — the HRMS app is a separate
    install since v14 and is not installed here. Split across cost centres so the
    voucher has a realistic line count."""
    bdays = weekdays_in_month(month)
    last_bd = bdays[-1]
    splits = [("admin", rng.uniform(17000, 21000)),
              ("sales", rng.uniform(19000, 24000)),
              ("warehouse", rng.uniform(14000, 18000))]
    lines, gross = [], 0.0
    for cc_key, amt in splits:
        amt = round(amt, 2)
        gross += amt
        lines.append({"account": ACCT["salaries"], "debit_in_account_currency": amt,
                      "cost_center": CC[cc_key]})
    gross = round(gross, 2)
    wh = round(gross * 0.224, 2)
    net = round(gross - wh, 2)
    lines.append({"account": ACCT["payroll_pay"], "credit_in_account_currency": net,
                  "cost_center": CC["admin"]})
    lines.append({"account": ACCT["tax_wh"], "credit_in_account_currency": wh,
                  "cost_center": CC["admin"]})
    make_je(last_bd, lines, BOT_USER, f"Payroll accrual {YEAR}-{month:02d}")

    pay_day = last_bd + timedelta(days=3)
    if pay_day.year != YEAR:
        pay_day = date(YEAR, 12, 31)
    make_je(pay_day, [
        {"account": ACCT["payroll_pay"], "debit_in_account_currency": net,
         "cost_center": CC["admin"]},
        {"account": ACCT["bank"], "credit_in_account_currency": net,
         "cost_center": CC["admin"]},
    ], BOT_USER, f"Payroll disbursement {YEAR}-{month:02d}", voucher_type="Bank Entry")

    # quarterly withholding remittance
    if month in (3, 6, 9, 12):
        rem_day = min(last_bd + timedelta(days=2), date(YEAR, 12, 31))
        bal = round(wh * 3, 2)
        make_je(rem_day, [
            {"account": ACCT["tax_wh"], "debit_in_account_currency": bal,
             "cost_center": CC["admin"]},
            {"account": ACCT["bank"], "credit_in_account_currency": bal,
             "cost_center": CC["admin"]},
        ], BOT_USER, f"Payroll tax remittance Q{(month - 1) // 3 + 1} {YEAR}",
            voucher_type="Bank Entry")


def month_depreciation(rng, month):
    last_bd = weekdays_in_month(month)[-1]
    # straight-line, deliberately constant month to month, split by cost centre
    make_je(last_bd, [
        {"account": ACCT["dep_exp"], "debit_in_account_currency": 2158.33,
         "cost_center": CC["warehouse"]},
        {"account": ACCT["dep_exp"], "debit_in_account_currency": 1258.34,
         "cost_center": CC["admin"]},
        {"account": ACCT["acc_dep"], "credit_in_account_currency": 3416.67,
         "cost_center": CC["admin"]},
    ], BOT_USER, f"Monthly depreciation {YEAR}-{month:02d}",
        voucher_type="Depreciation Entry")


def month_prepaid_amortisation(rng, month):
    """Insurance prepaid released monthly by the batch user."""
    last_bd = weekdays_in_month(month)[-1]
    amt = 1450.00
    make_je(last_bd, [
        {"account": ACCT["insurance"], "debit_in_account_currency": amt,
         "cost_center": CC["admin"]},
        {"account": ACCT["prepaid"], "credit_in_account_currency": amt,
         "cost_center": CC["admin"]},
    ], BOT_USER, f"Prepaid insurance amortisation {YEAR}-{month:02d}")


def month_intercompany(rng, month):
    """P2-only: monthly management fee charged to the subsidiary, mirrored in the
    subsidiary's books. Only the parent side reaches the exports."""
    days = weekdays_in_month(month)
    day = days[min(14, len(days) - 1)]
    amt = round(rng.uniform(8000, 12000), 2)
    make_je(day, [
        {"account": ACCT["ic_receivable"], "debit_in_account_currency": amt,
         "cost_center": CC["admin"]},
        {"account": ACCT["service"], "credit_in_account_currency": amt,
         "cost_center": CC["admin"]},
    ], CTRL_USER, f"Intercompany management fee - {SUB_COMPANY} {YEAR}-{month:02d}")
    make_je(day, [
        {"account": ACCT["sub_mgmt_fee"], "debit_in_account_currency": amt,
         "cost_center": ACCT["sub_cc"]},
        {"account": ACCT["sub_ic_payable"], "credit_in_account_currency": amt,
         "cost_center": ACCT["sub_cc"]},
    ], CTRL_USER, f"Management fee payable to {COMPANY} {YEAR}-{month:02d}",
        company=SUB_COMPANY)


def month_overhead_allocation(rng, month):
    """Standard month-end practice: shared overhead sitting in Admin is pushed out
    to the operating cost centres. Produces the population's large multi-line
    vouchers, which is what makes the entry-size histogram non-degenerate."""
    last_bd = weekdays_in_month(month)[-1]
    pools = [("Office Rent", rng.uniform(9000, 11000)),
             ("Utility Expenses", rng.uniform(2200, 3800)),
             ("Telephone Expenses", rng.uniform(700, 1400))]
    lines = []
    for name, total in pools:
        total = round(total, 2)
        a = round(total * 0.45, 2)
        b = round(total * 0.35, 2)
        c = round(total - a - b, 2)
        lines.append({"account": acct(name), "debit_in_account_currency": a,
                      "cost_center": CC["sales"]})
        lines.append({"account": acct(name), "debit_in_account_currency": b,
                      "cost_center": CC["warehouse"]})
        lines.append({"account": acct(name), "credit_in_account_currency": a + b,
                      "cost_center": CC["admin"]})
        del c
    make_je(last_bd, lines, CTRL_USER,
            f"Overhead allocation to operating cost centres {YEAR}-{month:02d}")


def quarter_bonus_accrual(rng, month):
    """Quarterly bonus accrual by cost centre, reversed the following month."""
    if month % 3 != 0:
        return
    last_bd = weekdays_in_month(month)[-1]
    amounts = {k: round(rng.uniform(6000, 14000), 2) for k in ("sales", "warehouse", "admin")}
    total = round(sum(amounts.values()), 2)
    lines = [{"account": ACCT["salaries"], "debit_in_account_currency": v,
              "cost_center": CC[k]} for k, v in amounts.items()]
    lines.append({"account": ACCT["accrued"], "credit_in_account_currency": total,
                  "cost_center": CC["admin"]})
    make_je(last_bd, lines, BOT_USER, f"Quarterly bonus accrual Q{(month - 1) // 3 + 1} {YEAR}")

    if month < 12:
        rev_day = weekdays_in_month(month + 1)[0]
        rev = [{"account": ACCT["salaries"], "credit_in_account_currency": v,
                "cost_center": CC[k]} for k, v in amounts.items()]
        rev.append({"account": ACCT["accrued"], "debit_in_account_currency": total,
                    "cost_center": CC["admin"]})
        make_je(rev_day, rev, BOT_USER,
                f"Reversal of Q{(month - 1) // 3 + 1} bonus accrual")


def month_accruals(rng, month):
    """Controller month-end entries. Accruals are round because they are estimates;
    reclasses and true-ups are not. Nothing here is aimed at a scoring rule."""
    days = weekdays_in_month(month)
    for _ in range(rng.randint(2, 5)):
        day = rng.choice(days[-8:])
        kind = rng.choices(["accrual", "reclass", "correction"], weights=[45, 35, 20])[0]
        if kind == "accrual":
            amt = float(rng.choice([2500, 5000, 7500, 10000, 12500]))
            make_je(day, [
                {"account": ACCT["utilities"], "debit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
                {"account": ACCT["accrued"], "credit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
            ], CTRL_USER, f"Month-end utilities accrual {YEAR}-{month:02d}")
        elif kind == "reclass":
            amt = round(rng.uniform(300, 4200), 2)
            a, b = rng.sample(["Office Maintenance Expenses", "Utility Expenses",
                               "Marketing Expenses", "Miscellaneous Expenses",
                               "Travel Expenses", "Print and Stationery"], 2)
            make_je(day, [
                {"account": acct(a), "debit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
                {"account": acct(b), "credit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
            ], CTRL_USER, f"Reclass {a} <- {b} {YEAR}-{month:02d}")
        else:
            amt = round(rng.uniform(50, 900), 2)
            make_je(day, [
                {"account": ACCT["misc"], "debit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
                {"account": ACCT["cash"], "credit_in_account_currency": amt,
                 "cost_center": CC["admin"]},
            ], CTRL_USER, f"Petty cash true-up {YEAR}-{month:02d}",
                voucher_type="Cash Entry")


# --------------------------------------------------------------------------
# monthly run
# --------------------------------------------------------------------------

def month_done(month):
    """Resume guard: has this month already been driven? Counts only originating
    sales invoices — credit notes and payments from the prior month spill into
    this one and must not be mistaken for a completed month."""
    start = date(YEAR, month, 1)
    end = date(YEAR, month, calendar.monthrange(YEAR, month)[1])
    return frappe.db.count("Sales Invoice", {
        "company": COMPANY, "docstatus": 1, "is_return": 0,
        "posting_date": ["between", [str(start), str(end)]],
    }) >= 20


def run_month(period_key, month):
    if month_done(month):
        print(f"MONTH_SKIP {YEAR}-{month:02d} (already driven)")
        return
    rng = random.Random(20250000 + month)
    days = weekdays_in_month(month)

    # --- Sales ---
    n_si = rng.randint(44, 58)
    open_invoices = []
    for _ in range(n_si):
        day = rng.choice(days)
        customer = rng.choice(CUSTOMERS)
        items = pick_items(rng, period_key)
        # unusual-user texture: the controller covers ~2% of AR postings
        user = CTRL_USER if rng.random() < 0.02 else AR_USER
        si = make_si(rng, day, customer, items, user=user)
        open_invoices.append((si, day))

    # P2 structural change 1: new revenue line, sales begin in August
    if period_key == "P2" and month >= 8:
        for it, cnt in INSTALL_ITEMS:
            for _ in range(rng.randint(max(1, cnt - 2), cnt + 2)):
                day = rng.choice(days)
                std = float(frappe.db.get_value("Item", it, "standard_rate"))
                extra = []
                if rng.random() < 0.4:  # installation often billed with product
                    prod = rng.choice(["Standard Widget", "Premium Widget", "Anchor Bolt Set"])
                    pstd = float(frappe.db.get_value("Item", prod, "standard_rate"))
                    extra.append((prod, rng.randint(1, 10),
                                  round(pstd * rng.uniform(0.95, 1.1), 2)))
                items = [(it, rng.randint(1, 3),
                          round(std * rng.uniform(0.95, 1.08), 2))] + extra
                si = make_si(rng, day, rng.choice(CUSTOMERS), items)
                open_invoices.append((si, day))

    # Customer returns: ~3% of invoices come back as a credit note
    for si, day in list(open_invoices):
        if rng.random() < 0.03:
            ret_day = min(day + timedelta(days=rng.randint(3, 25)), date(YEAR, 12, 28))
            try:
                make_credit_note(rng, si, ret_day)
            except Exception as e:  # a fully-paid or partly-consumed invoice may refuse
                print("   credit note skipped:", type(e).__name__)

    # Customer payments: ~85% collected, ~10% of those partial
    for si, day in open_invoices:
        r = rng.random()
        if r < 0.85:
            pay_day = min(day + timedelta(days=rng.randint(5, 40)), date(YEAR, 12, 28))
            frac = round(rng.uniform(0.4, 0.7), 2) if rng.random() < 0.10 else None
            pay_invoice(rng, si, pay_day, AR_USER, fraction=frac)

    # --- Purchases ---
    widx = 1 if period_key == "P1" else 2
    open_pis = []
    for supplier, (exp, c1, c2) in SUPPLIERS.items():
        cnt = c1 if widx == 1 else c2
        for _ in range(cnt):
            day = rng.choice(days)
            amount = round(rng.uniform(400, 18000), 2)
            cc = CC["warehouse"] if exp == "Cost of Goods Sold" else CC["admin"]
            pi = make_pi(rng, day, supplier, acct(exp), amount, cost_center=cc)
            open_pis.append((pi, day))
    for pi, day in open_pis:
        if rng.random() < 0.90:
            pay_day = min(day + timedelta(days=rng.randint(10, 45)), date(YEAR, 12, 28))
            frac = round(rng.uniform(0.5, 0.8), 2) if rng.random() < 0.07 else None
            pay_invoice(rng, pi, pay_day, AP_USER, fraction=frac)

    # --- Month-end batches ---
    month_payroll(rng, month)
    month_depreciation(rng, month)
    month_prepaid_amortisation(rng, month)
    month_overhead_allocation(rng, month)
    quarter_bonus_accrual(rng, month)
    month_accruals(rng, month)
    if period_key == "P2":
        month_intercompany(rng, month)  # P2 structural change 3

    frappe.db.commit()
    n_gl = frappe.db.count("GL Entry", {"company": COMPANY})
    print(f"MONTH_DONE {YEAR}-{month:02d} si={n_si} pi={len(open_pis)} gl_rows_total={n_gl}",
          flush=True)


def run(period_key):
    frappe.set_user("Administrator")
    frappe.flags.in_import = True
    start_m, end_m = PERIODS[period_key]
    check_accounts()
    try:
        for month in range(start_m, end_m + 1):
            try:
                run_month(period_key, month)
            except Exception:
                frappe.db.rollback()
                traceback.print_exc()
                raise
    finally:
        frappe.set_user("Administrator")
    n = frappe.db.count("GL Entry", {"company": COMPANY, "is_cancelled": 0})
    print(f"PERIOD_DONE {period_key} gl_rows={n}", flush=True)


def reset_transactions():
    """Wipe every posted transaction (both companies) so a driving run can be
    repeated from scratch. Master data and the chart of accounts are untouched.
    Demo instance only — this is a raw SQL truncate, not a cancel/delete cycle."""
    frappe.set_user("Administrator")
    tables = [
        "GL Entry", "Payment Ledger Entry", "Repost Payment Ledger",
        "Repost Payment Ledger Items", "Repost Accounting Ledger",
        "Repost Accounting Ledger Items", "Stock Ledger Entry",
        "Sales Invoice Item", "Sales Taxes and Charges", "Sales Invoice",
        "Purchase Invoice Item", "Purchase Taxes and Charges", "Purchase Invoice",
        "Payment Entry Reference", "Payment Entry Deduction", "Payment Entry",
        "Journal Entry Account", "Journal Entry",
        "Advance Payment Ledger Entry", "Accounts Closing Balance",
    ]
    frappe.db.sql("SET FOREIGN_KEY_CHECKS=0")
    for t in tables:
        try:
            frappe.db.sql(f"DELETE FROM `tab{t}`")
        except Exception as e:
            print("  skip", t, type(e).__name__)
    frappe.db.sql("SET FOREIGN_KEY_CHECKS=1")
    frappe.db.sql("DELETE FROM `tabSeries` WHERE name LIKE 'ACC-%'")
    frappe.db.commit()
    print("RESET_OK gl_rows=", frappe.db.count("GL Entry"))


def smoke(period_key="P1", month="1"):
    """Drive a single month and report shape, so mistakes cost 1/12th."""
    frappe.set_user("Administrator")
    frappe.flags.in_import = True
    check_accounts()
    try:
        run_month(period_key, int(month))
    finally:
        frappe.set_user("Administrator")
    stats()


def stats():
    frappe.set_user("Administrator")
    rows = frappe.db.sql("""
        SELECT voucher_type, COUNT(DISTINCT voucher_no) AS vouchers, COUNT(*) AS gl_rows
        FROM `tabGL Entry`
        WHERE company=%s AND is_cancelled=0
        GROUP BY voucher_type ORDER BY gl_rows DESC
    """, (COMPANY,), as_dict=True)
    for r in rows:
        print(f"  {r.voucher_type:20s} vouchers={r.vouchers:6d} gl_rows={r.gl_rows:6d}")
    print("  owners:", frappe.db.sql("""
        SELECT owner, COUNT(*) FROM `tabGL Entry`
        WHERE company=%s AND is_cancelled=0 GROUP BY owner""", (COMPANY,)))
    print("  lines-per-voucher histogram:", frappe.db.sql("""
        SELECT n, COUNT(*) FROM (
          SELECT voucher_no, COUNT(*) n FROM `tabGL Entry`
          WHERE company=%s AND is_cancelled=0 GROUP BY voucher_no) t
        GROUP BY n ORDER BY n""", (COMPANY,)))
    unbal = frappe.db.sql("""
        SELECT voucher_no, ROUND(SUM(debit)-SUM(credit),4) d FROM `tabGL Entry`
        WHERE company=%s AND is_cancelled=0
        GROUP BY voucher_no HAVING ABS(d) > 0.005""", (COMPANY,))
    print("  unbalanced vouchers:", len(unbal), unbal[:5])
