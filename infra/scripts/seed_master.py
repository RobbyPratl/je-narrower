# Master data for the JE population testing demo.
#
# Run AFTER setup_site.main() has completed the setup wizard:
#   docker exec erpnext-backend-1 bash -c \
#     'cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py seed_master main'
#
# Idempotent: every create is guarded by an existence check.
#
# Account references are resolved by (company, account_name) lookup, never by
# string-building, because the "Standard with Numbers" chart names accounts
# "5217 - Utility Expenses - MTC".

import frappe

COMPANY = "Meridian Trading Co."
ABBR = "MTC"
SUB_COMPANY = "Meridian Logistics LLC"
SUB_ABBR = "MLL"
CURRENCY = "USD"
COUNTRY = "United States"

USERS = [
    ("ar.clerk@meridian.example", "Avery", "Reyes",
     ["Accounts User", "Sales User", "Sales Manager"]),
    ("ap.clerk@meridian.example", "Parker", "Nolan",
     ["Accounts User", "Purchase User", "Purchase Manager"]),
    ("controller@meridian.example", "Casey", "Lindqvist",
     ["Accounts Manager", "Accounts User", "Sales Manager", "Purchase Manager"]),
    ("batch.bot@meridian.example", "Batch", "Bot",
     ["Accounts Manager", "Accounts User"]),
]

COST_CENTERS = ["Sales Ops", "Warehouse", "Admin"]

# (account_name, parent account_name, account_type, account_number)
# Parents are existing accounts in the generated chart (verified from dump_chart).
NEW_ACCOUNTS = [
    # Bank leaf: the wizard leaves "1200 - Bank Accounts" as an empty group.
    ("Primary Checking", "Bank Accounts", "Bank", "1210"),
    # Income accounts so multi-item invoices produce multi-row GL vouchers
    # (ERPNext merges GL rows by account + cost_center, so one income account
    # per invoice would collapse every sale to a 2-row voucher).
    ("Freight Income", "Direct Income", None, "4130"),
    ("Installation Revenue", "Direct Income", None, "4140"),   # P2 only -> NEW pairings
    # Intercompany: no account_type, so JE lines need no party.
    ("Intercompany Receivable", "Accounts Receivable", None, "1320"),  # P2 only
    # Payroll / statutory
    ("Tax Withholding Payable", "Duties and Taxes", None, "2320"),
    # Expense lines the supplier schedule needs but the standard chart lacks
    ("Contractor Services", "Indirect Expenses", None, "5226"),      # P1 only -> VANISHED
    ("Equipment Lease Expense", "Indirect Expenses", None, "5227"),  # P2 only -> NEW
    ("Insurance Expense", "Indirect Expenses", None, "5228"),
    ("Security Expenses", "Indirect Expenses", None, "5229"),
    ("IT and Software Expenses", "Indirect Expenses", None, "5230"),
]

# Accounts created on the subsidiary for the mirrored intercompany JE.
SUB_ACCOUNTS = [
    ("Intercompany Payable", "Accounts Payable", None, "2130"),
    ("Management Fee Expense", "Indirect Expenses", None, "5226"),
]

CUSTOMERS = [
    "Northwind Retail", "Cascade Outfitters", "Bluepine Hardware", "Juniper & Co",
    "Halstrom Supply", "Redcedar Builders", "Marlowe Interiors", "Pactrail Sports",
    "Ovation Events", "Kestrel Foods", "Brightline Offices", "Summit Rentals",
    "Ferrous Works", "Galehouse Media", "Timberline Schools",
]

SUPPLIERS = [
    ("Orchard Wholesale", "Local"), ("Vulcan Materials Co", "Local"),
    ("Beacon Freight", "Services"), ("Cobalt IT Services", "Services"),
    ("Stateside Insurance", "Services"), ("Metro Utilities", "Services"),
    ("Harlan Office Supply", "Local"), ("Quill Marketing Group", "Services"),
    ("Ironclad Security", "Services"),
    ("Fairbanks Consulting", "Services"),        # P1 only, vanishes after June
    ("Sterling Equipment Leasing", "Services"),  # P2 only, NEW
    ("Granite Janitorial", "Services"),
]

# (item_code, standard_rate, item_group, income account_name)
ITEMS = [
    ("Standard Widget", 42.50, "Products", "Sales"),
    ("Premium Widget", 118.00, "Products", "Sales"),
    ("Widget Mounting Kit", 17.25, "Products", "Sales"),
    ("Industrial Fastener Pack", 63.75, "Products", "Sales"),
    ("Sealant Cartridge", 12.40, "Products", "Sales"),
    ("Anchor Bolt Set", 29.90, "Products", "Sales"),
    ("Site Survey", 350.00, "Services", "Service"),
    ("Maintenance Plan - Annual", 1200.00, "Services", "Service"),
    ("Custom Fabrication", 780.00, "Services", "Service"),
    ("Freight & Handling", 85.00, "Services", "Freight Income"),
]

P2_ITEMS = [
    ("Installation - Standard", 450.00, "Services", "Installation Revenue"),
    ("Installation - Complex", 1150.00, "Services", "Installation Revenue"),
]


def acct(account_name, company=COMPANY, is_group=0):
    """Resolve an account by its human name within a company. Never string-build."""
    filters = {"company": company, "account_name": account_name}
    if is_group is not None:
        filters["is_group"] = is_group
    name = frappe.db.get_value("Account", filters, "name")
    if not name:
        raise Exception(f"Account not found: {account_name!r} in {company!r}")
    return name


def _ensure_company(name, abbr):
    if frappe.db.exists("Company", name):
        return
    frappe.get_doc({
        "doctype": "Company",
        "company_name": name,
        "abbr": abbr,
        "default_currency": CURRENCY,
        "country": COUNTRY,
        "create_chart_of_accounts_based_on": "Standard Template",
        "chart_of_accounts": "Standard with Numbers",
        "valuation_method": "FIFO",
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    print("created company", name)


def _ensure_account(account_name, parent_name, account_type, number, company, abbr):
    existing = frappe.db.get_value(
        "Account", {"company": company, "account_name": account_name},
        ["name", "account_number"], as_dict=True)
    if existing:
        # backfill the number so the whole chart is uniformly numbered
        # ("5217 - Utility Expenses - MTC" style), then rename to match.
        if number:
            if not existing.account_number:
                frappe.db.set_value("Account", existing.name, "account_number", number)
            want = f"{number} - {account_name} - {abbr}"
            if existing.name != want and not frappe.db.exists("Account", want):
                frappe.rename_doc("Account", existing.name, want, force=True)
                frappe.db.commit()
                print("renamed account ->", want)
        return
    parent = acct(parent_name, company=company, is_group=1)
    doc = {
        "doctype": "Account",
        "account_name": account_name,
        "parent_account": parent,
        "company": company,
        "is_group": 0,
    }
    if account_type:
        doc["account_type"] = account_type
    if number:
        doc["account_number"] = number
    frappe.get_doc(doc).insert(ignore_permissions=True)
    print("created account", account_name, "under", parent)


def main():
    frappe.set_user("Administrator")
    frappe.flags.in_import = True

    # --- Companies ---
    _ensure_company(COMPANY, ABBR)
    _ensure_company(SUB_COMPANY, SUB_ABBR)

    # --- Fiscal year (created by the wizard, asserted here) ---
    if not frappe.db.exists("Fiscal Year", "2025"):
        frappe.get_doc({
            "doctype": "Fiscal Year", "year": "2025",
            "year_start_date": "2025-01-01", "year_end_date": "2025-12-31",
        }).insert(ignore_permissions=True)

    # --- Users ---
    for email, first, last, roles in USERS:
        if not frappe.db.exists("User", email):
            frappe.get_doc({
                "doctype": "User",
                "email": email,
                "first_name": first,
                "last_name": last,
                "send_welcome_email": 0,
                "user_type": "System User",
                "roles": [{"role": r} for r in roles],
            }).insert(ignore_permissions=True)
            print("created user", email)

    # --- Cost centers ---
    root_cc = frappe.db.get_value(
        "Cost Center",
        {"company": COMPANY, "is_group": 1, "parent_cost_center": ["in", ["", None]]},
        "name")
    if not root_cc:  # fall back to the shallowest group cost center
        root_cc = frappe.db.get_value(
            "Cost Center", {"company": COMPANY, "is_group": 1}, "name", order_by="lft")
    if not root_cc:
        raise Exception("no root cost center for " + COMPANY)
    for cc in COST_CENTERS:
        if not frappe.db.get_value("Cost Center", {"company": COMPANY, "cost_center_name": cc}):
            frappe.get_doc({
                "doctype": "Cost Center",
                "cost_center_name": cc,
                "parent_cost_center": root_cc,
                "company": COMPANY,
                "is_group": 0,
            }).insert(ignore_permissions=True)
            print("created cost center", cc)

    # --- Accounts ---
    for account_name, parent, atype, num in NEW_ACCOUNTS:
        _ensure_account(account_name, parent, atype, num, COMPANY, ABBR)
    for account_name, parent, atype, num in SUB_ACCOUNTS:
        _ensure_account(account_name, parent, atype, num, SUB_COMPANY, SUB_ABBR)

    # Company defaults that the wizard left blank
    comp = frappe.get_doc("Company", COMPANY)
    changed = False
    if not comp.default_bank_account:
        comp.default_bank_account = acct("Primary Checking")
        changed = True
    if not comp.default_cash_account:
        comp.default_cash_account = acct("Cash")
        changed = True
    if not comp.default_receivable_account:
        comp.default_receivable_account = acct("Debtors")
        changed = True
    if not comp.default_payable_account:
        comp.default_payable_account = acct("Creditors")
        changed = True
    if not comp.default_expense_account:
        comp.default_expense_account = acct("Cost of Goods Sold")
        changed = True
    if not comp.default_income_account:
        comp.default_income_account = acct("Sales")
        changed = True
    if changed:
        comp.save(ignore_permissions=True)
        print("company defaults set")

    # --- Sales tax template (adds a tax row to invoice GL vouchers) ---
    tax_tpl = "Meridian Sales Tax"
    if not frappe.db.exists("Sales Taxes and Charges Template", f"{tax_tpl} - {ABBR}"):
        frappe.get_doc({
            "doctype": "Sales Taxes and Charges Template",
            "title": tax_tpl,
            "company": COMPANY,
            "taxes": [{
                "charge_type": "On Net Total",
                "account_head": acct("ST 6%"),
                "description": "State Sales Tax 6%",
                "rate": 6.0,
                "cost_center": frappe.db.get_value(
                    "Cost Center", {"company": COMPANY, "cost_center_name": "Admin"}, "name"),
            }],
        }).insert(ignore_permissions=True)
        print("created sales tax template")

    # --- Customers ---
    cust_group = (frappe.db.get_value("Customer Group", {"is_group": 0}, "name")
                  or "All Customer Groups")
    territory = frappe.db.get_value("Territory", {"is_group": 0}, "name") or "All Territories"
    for c in CUSTOMERS:
        if not frappe.db.exists("Customer", c):
            frappe.get_doc({
                "doctype": "Customer", "customer_name": c, "customer_type": "Company",
                "customer_group": cust_group, "territory": territory,
            }).insert(ignore_permissions=True)

    # --- Suppliers ---
    for s, group in SUPPLIERS:
        if not frappe.db.exists("Supplier", s):
            frappe.get_doc({
                "doctype": "Supplier", "supplier_name": s,
                "supplier_type": "Company",
                "supplier_group": group if frappe.db.exists("Supplier Group", group)
                else "All Supplier Groups",
            }).insert(ignore_permissions=True)

    # --- Items (all non-stock: GL postings stay direct, no stock ledger) ---
    for code, rate, group, income in ITEMS + P2_ITEMS:
        if not frappe.db.exists("Item", code):
            frappe.get_doc({
                "doctype": "Item",
                "item_code": code, "item_name": code,
                "item_group": group,
                "stock_uom": "Nos",
                "is_stock_item": 0,
                "is_sales_item": 1,
                "is_purchase_item": 0,
                "standard_rate": rate,
                "item_defaults": [{
                    "company": COMPANY,
                    "income_account": acct(income),
                    "selling_cost_center": frappe.db.get_value(
                        "Cost Center", {"company": COMPANY, "cost_center_name": "Sales Ops"}, "name"),
                }],
            }).insert(ignore_permissions=True)

    frappe.db.commit()
    verify()
    print("MASTER_DATA_OK")


def verify():
    frappe.set_user("Administrator")
    print("companies:", frappe.get_all("Company", pluck="name"))
    print("users:", [u for u in frappe.get_all("User", pluck="name") if "meridian" in u])
    print("cost_centers:", frappe.get_all(
        "Cost Center", filters={"company": COMPANY, "is_group": 0}, pluck="name"))
    print("customers:", frappe.db.count("Customer"))
    print("suppliers:", frappe.db.count("Supplier"))
    print("items:", frappe.db.count("Item"))
    for a in ["Primary Checking", "Freight Income", "Installation Revenue",
              "Intercompany Receivable", "Contractor Services", "Equipment Lease Expense",
              "Tax Withholding Payable", "Insurance Expense", "Security Expenses",
              "IT and Software Expenses", "Payroll Payable", "Salary", "Depreciation",
              "Accumulated Depreciation", "Debtors", "Creditors", "Cash", "Sales", "Service"]:
        print("  acct", a, "->", acct(a))
