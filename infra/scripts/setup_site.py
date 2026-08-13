# Step 0: complete the Frappe/ERPNext setup wizard programmatically.
#
# A freshly-created site has NO ERPNext fixtures (no UOMs, no Item Groups, no
# Warehouse Types), which is why creating a Company directly fails with
#   LinkValidationError: Could not find Warehouse Type: Transit
# The wizard installs those fixtures and creates the main company + fiscal year.
#
# Run:
#   docker exec erpnext-backend-1 bash -c \
#     'cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py setup_site main'
#
# Idempotent: returns early if setup is already complete.

import frappe

COMPANY = "Meridian Trading Co."
ABBR = "MTC"
CURRENCY = "USD"
COUNTRY = "United States"


def list_charts():
    from erpnext.accounts.doctype.account.chart_of_accounts.chart_of_accounts import (
        get_charts_for_country,
    )

    charts = get_charts_for_country(COUNTRY)
    print("AVAILABLE_CHARTS:", charts)
    return charts


def main(chart="Standard with Numbers"):
    frappe.set_user("Administrator")
    if frappe.db.get_single_value("System Settings", "setup_complete"):
        print("SETUP_ALREADY_COMPLETE")
        return

    charts = list_charts()
    if chart not in charts:
        raise SystemExit(f"Chart {chart!r} not in {charts}")

    from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

    args = {
        "language": "English",
        "country": COUNTRY,
        "timezone": "America/New_York",
        "currency": CURRENCY,
        "full_name": "Administrator",
        "email": "admin@meridian.example",
        "password": "admin",
        "company_name": COMPANY,
        "company_abbr": ABBR,
        "chart_of_accounts": chart,
        "fy_start_date": "2025-01-01",
        "fy_end_date": "2025-12-31",
        "domain": "Distribution",
        "setup_demo": 0,
        "enable_telemetry": 0,
    }
    res = setup_complete(args)
    frappe.db.commit()
    print("SETUP_RESULT:", res)
    verify()


def verify():
    frappe.set_user("Administrator")
    print("setup_complete:", frappe.db.get_single_value("System Settings", "setup_complete"))
    print("companies:", frappe.get_all("Company", pluck="name"))
    print("fiscal_years:", frappe.get_all("Fiscal Year", pluck="name"))
    print("warehouse_types:", frappe.get_all("Warehouse Type", pluck="name"))
    print("uoms:", frappe.db.count("UOM"))
    print("item_groups:", frappe.get_all("Item Group", pluck="name"))
    print("supplier_groups:", frappe.get_all("Supplier Group", pluck="name"))
    print("accounts:", frappe.db.count("Account"))


def dump_chart():
    """Dump the real generated chart so account references can be resolved by
    account_name rather than by guessed string-building."""
    rows = frappe.get_all(
        "Account",
        filters={"company": COMPANY},
        fields=["name", "account_name", "account_number", "parent_account",
                "account_type", "root_type", "is_group"],
        order_by="lft",
    )
    for r in rows:
        print("|".join(str(r.get(k) or "") for k in
                       ("name", "account_name", "account_number", "parent_account",
                        "account_type", "root_type", "is_group")))
    print("TOTAL_ACCOUNTS", len(rows))
