# Exports for the ingest workstream.
#
#   docker exec erpnext-backend-1 bash -c \
#     'cd /home/frappe/frappe-bench/sites && ../env/bin/python /tmp/jerun.py export main'
#   docker cp erpnext-backend-1:/tmp/exports/. <host>/data/exports/
#
# Writes, for each period:
#   gl_p1.csv / gl_p2.csv          one row per GL Entry line
#   tb_p1.csv / tb_p2.csv          trial balance: opening + activity = closing
#   gl_p2_truncated.csv            P2 minus its last ~5% of rows, for the
#                                  completeness-gate failure demo
#
# Main company only — the subsidiary's intercompany mirror never reaches these
# files. Cancelled GL rows are excluded.
#
# Every sanity check runs BEFORE the files are written, and a failure aborts.

import csv
import os

import frappe

COMPANY = "Meridian Trading Co."
OUT = "/tmp/exports"

PERIODS = {
    "P1": ("2025-01-01", "2025-06-30"),
    "P2": ("2025-07-01", "2025-12-31"),
}

GL_COLUMNS = [
    "line_id", "entry_id", "period", "voucher_type", "voucher_subtype", "line_no",
    "posting_date", "created_at", "user",
    "account", "account_number", "account_name", "root_type",
    "debit", "credit", "party_type", "party", "against", "cost_center",
    "remarks", "company",
]

TB_COLUMNS = [
    "account", "account_number", "account_name", "root_type", "account_type",
    "opening_debit", "opening_credit", "period_debit", "period_credit",
    "closing_debit", "closing_credit",
]

TRUNCATE_FRACTION = 0.05


def _gl_rows(period):
    start, end = PERIODS[period]
    return frappe.db.sql("""
        SELECT
            gle.name                                  AS line_id,
            gle.voucher_no                            AS entry_id,
            %(period)s                                AS period,
            gle.voucher_type                          AS voucher_type,
            -- the document's own sub-classification: ERPNext records every
            -- manual entry as voucher_type 'Journal Entry' and keeps the real
            -- kind (Bank Entry, Depreciation Entry, ...) on the document, and
            -- credit notes are Sales Invoices with is_return set. Both are the
            -- 'source' dimension the scoring layer wants, so surface them here.
            COALESCE(je.voucher_type,
                     CASE WHEN si.is_return = 1 THEN 'Credit Note' END,
                     gle.voucher_type)                 AS voucher_subtype,
            ROW_NUMBER() OVER (PARTITION BY gle.voucher_no
                               ORDER BY gle.creation, gle.name) AS line_no,
            gle.posting_date                          AS posting_date,
            gle.creation                              AS created_at,
            gle.owner                                 AS user,
            gle.account                               AS account,
            acc.account_number                        AS account_number,
            acc.account_name                          AS account_name,
            acc.root_type                             AS root_type,
            gle.debit                                 AS debit,
            gle.credit                                AS credit,
            gle.party_type                            AS party_type,
            gle.party                                 AS party,
            gle.against                               AS against,
            gle.cost_center                           AS cost_center,
            gle.remarks                               AS remarks,
            gle.company                               AS company
        FROM `tabGL Entry` gle
        LEFT JOIN `tabAccount` acc ON acc.name = gle.account
        LEFT JOIN `tabJournal Entry` je
               ON gle.voucher_type = 'Journal Entry' AND je.name = gle.voucher_no
        LEFT JOIN `tabSales Invoice` si
               ON gle.voucher_type = 'Sales Invoice' AND si.name = gle.voucher_no
        WHERE gle.company = %(company)s
          AND gle.is_cancelled = 0
          AND gle.posting_date BETWEEN %(start)s AND %(end)s
        ORDER BY gle.posting_date, gle.voucher_no, gle.creation, gle.name
    """, {"company": COMPANY, "start": start, "end": end, "period": period},
        as_dict=True)


def _tb_rows(period):
    """Opening from every GL row before the period start, activity within it.
    Derived purely from GL Entry sums, so the identity is arithmetic, not
    asserted — which is exactly what the completeness gate must be able to check.
    """
    start, end = PERIODS[period]
    rows = frappe.db.sql("""
        SELECT
            gle.account,
            acc.account_number, acc.account_name, acc.root_type, acc.account_type,
            SUM(CASE WHEN gle.posting_date <  %(start)s THEN gle.debit  ELSE 0 END) AS op_dr,
            SUM(CASE WHEN gle.posting_date <  %(start)s THEN gle.credit ELSE 0 END) AS op_cr,
            SUM(CASE WHEN gle.posting_date >= %(start)s AND gle.posting_date <= %(end)s
                     THEN gle.debit  ELSE 0 END) AS pd_dr,
            SUM(CASE WHEN gle.posting_date >= %(start)s AND gle.posting_date <= %(end)s
                     THEN gle.credit ELSE 0 END) AS pd_cr
        FROM `tabGL Entry` gle
        LEFT JOIN `tabAccount` acc ON acc.name = gle.account
        WHERE gle.company = %(company)s
          AND gle.is_cancelled = 0
          AND gle.posting_date <= %(end)s
        GROUP BY gle.account, acc.account_number, acc.account_name,
                 acc.root_type, acc.account_type
        ORDER BY (acc.account_number IS NULL OR acc.account_number = ''),
                 acc.account_number, gle.account
    """, {"company": COMPANY, "start": start, "end": end}, as_dict=True)

    out = []
    for r in rows:
        opening = round(float(r.op_dr) - float(r.op_cr), 2)
        pdr, pcr = round(float(r.pd_dr), 2), round(float(r.pd_cr), 2)
        closing = round(opening + pdr - pcr, 2)
        out.append({
            "account": r.account,
            "account_number": r.account_number or "",
            "account_name": r.account_name or "",
            "root_type": r.root_type or "",
            "account_type": r.account_type or "",
            "opening_debit": opening if opening > 0 else 0.0,
            "opening_credit": -opening if opening < 0 else 0.0,
            "period_debit": pdr,
            "period_credit": pcr,
            "closing_debit": closing if closing > 0 else 0.0,
            "closing_credit": -closing if closing < 0 else 0.0,
        })
    return out


# --------------------------------------------------------------------------
# sanity checks — run before anything is written
# --------------------------------------------------------------------------

def _check(label, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    return ok


def sanity(gl, tb):
    ok = True

    for period in ("P1", "P2"):
        rows = gl[period]
        ok &= _check(f"{period} has entries", len(rows) > 0,
                     f"{len(rows)} lines, {len({r['entry_id'] for r in rows})} vouchers")

        # every voucher balances
        bal = {}
        for r in rows:
            d, c = bal.get(r["entry_id"], (0.0, 0.0))
            bal[r["entry_id"]] = (d + float(r["debit"]), c + float(r["credit"]))
        bad = {k: v for k, v in bal.items() if abs(v[0] - v[1]) > 0.005}
        ok &= _check(f"{period} every voucher balances (debits = credits)",
                     not bad, f"{len(bad)} unbalanced" if bad else f"{len(bal)} vouchers")

        # trial balance ties out per account
        tbr = tb[period]
        mism = []
        for r in tbr:
            opening = r["opening_debit"] - r["opening_credit"]
            closing = r["closing_debit"] - r["closing_credit"]
            if abs(opening + r["period_debit"] - r["period_credit"] - closing) > 0.005:
                mism.append(r["account"])
        ok &= _check(f"{period} TB opening + activity = closing, per account",
                     not mism, f"{len(mism)} accounts off" if mism else f"{len(tbr)} accounts")

        # TB period activity reconciles to the GL export
        gl_dr = round(sum(float(r["debit"]) for r in rows), 2)
        gl_cr = round(sum(float(r["credit"]) for r in rows), 2)
        tb_dr = round(sum(r["period_debit"] for r in tbr), 2)
        tb_cr = round(sum(r["period_credit"] for r in tbr), 2)
        ok &= _check(f"{period} TB activity reconciles to GL export",
                     abs(gl_dr - tb_dr) < 0.01 and abs(gl_cr - tb_cr) < 0.01,
                     f"GL {gl_dr:,.2f}/{gl_cr:,.2f} vs TB {tb_dr:,.2f}/{tb_cr:,.2f}")

        # the whole TB balances
        net = round(sum(r["closing_debit"] - r["closing_credit"] for r in tbr), 2)
        ok &= _check(f"{period} TB closing balances to zero", abs(net) < 0.01, f"net {net}")

        # every account used in the GL export is present in the TB
        gl_accounts = {r["account"] for r in rows}
        tb_accounts = {r["account"] for r in tbr}
        orphans = gl_accounts - tb_accounts
        ok &= _check(f"{period} every GL account appears in the TB", not orphans,
                     f"{len(gl_accounts)} GL / {len(tb_accounts)} TB accounts")

    # P1 opens at zero (new company)
    p1_open = round(sum(r["opening_debit"] + r["opening_credit"] for r in tb["P1"]), 2)
    ok &= _check("P1 opening balances are zero", abs(p1_open) < 0.01, f"sum {p1_open}")

    # P2 opening = P1 closing, per account
    p1_close = {r["account"]: round(r["closing_debit"] - r["closing_credit"], 2)
                for r in tb["P1"]}
    drift = [r["account"] for r in tb["P2"]
             if abs(round(r["opening_debit"] - r["opening_credit"], 2)
                    - p1_close.get(r["account"], 0.0)) > 0.005]
    ok &= _check("P2 opening = P1 closing, per account", not drift,
                 f"{len(drift)} accounts drift" if drift else f"{len(p1_close)} accounts")

    # structural changes: present in P2, absent from P1 (and the reverse)
    p1_accounts = {r["account"] for r in gl["P1"]}
    p2_accounts = {r["account"] for r in gl["P2"]}
    for acct_name in ("Installation Revenue", "Equipment Lease Expense",
                      "Intercompany Receivable"):
        matches_2 = {a for a in p2_accounts if acct_name in a}
        matches_1 = {a for a in p1_accounts if acct_name in a}
        ok &= _check(f"'{acct_name}' in P2 only", bool(matches_2) and not matches_1,
                     f"P1={sorted(matches_1)} P2={sorted(matches_2)}")
    for acct_name in ("Contractor Services",):
        matches_2 = {a for a in p2_accounts if acct_name in a}
        matches_1 = {a for a in p1_accounts if acct_name in a}
        ok &= _check(f"'{acct_name}' in P1 only", bool(matches_1) and not matches_2,
                     f"P1={sorted(matches_1)} P2={sorted(matches_2)}")

    # The vanished supplier stops being BILLED after June. It legitimately still
    # appears in early P2 on payment entries settling its final P1 invoices —
    # that is correct accounting, not a leak, so the assertion is about new
    # billing (Purchase Invoice), not about the party disappearing outright.
    def parties(period, vtype=None):
        return {r["party"] for r in gl[period]
                if r["party"] and (vtype is None or r["voucher_type"] == vtype)}

    ok &= _check("'Fairbanks Consulting' billed in P1, never billed in P2",
                 "Fairbanks Consulting" in parties("P1", "Purchase Invoice")
                 and "Fairbanks Consulting" not in parties("P2", "Purchase Invoice"),
                 "settlement payments in early P2 are expected and allowed")
    ok &= _check("'Sterling Equipment Leasing' is a P2-only party",
                 "Sterling Equipment Leasing" in parties("P2")
                 and "Sterling Equipment Leasing" not in parties("P1"))

    # nothing from the subsidiary leaked in
    companies = {r["company"] for p in ("P1", "P2") for r in gl[p]}
    ok &= _check("main company only", companies == {COMPANY}, str(sorted(companies)))

    # no voucher straddles the period cut — the ingest tags period per entry, so
    # an entry appearing in both files would double-count
    overlap = ({r["entry_id"] for r in gl["P1"]} & {r["entry_id"] for r in gl["P2"]})
    ok &= _check("no voucher appears in both periods", not overlap,
                 f"{len(overlap)} straddling" if overlap else "")

    # line_id is unique across the whole population (it is the lines primary key)
    all_lines = [r["line_id"] for p in ("P1", "P2") for r in gl[p]]
    ok &= _check("line_id unique across both periods",
                 len(all_lines) == len(set(all_lines)), f"{len(all_lines)} lines")

    # line_no is 1..n contiguous within every voucher
    seen = {}
    for p in ("P1", "P2"):
        for r in gl[p]:
            seen.setdefault(r["entry_id"], []).append(int(r["line_no"]))
    bad_idx = [k for k, v in seen.items() if sorted(v) != list(range(1, len(v) + 1))]
    ok &= _check("line_no is contiguous 1..n within each voucher", not bad_idx,
                 f"{len(bad_idx)} bad" if bad_idx else f"{len(seen)} vouchers")

    return ok


def _flatten(value):
    """ERPNext builds multi-line `remarks` on Payment Entries ("Amount USD ...\\n
    Transaction reference ...\\nAmount adjusted against ..."). Embedded newlines
    inside quoted CSV fields are legal RFC 4180 but break every naive
    line-oriented reader, so they are folded to ' | '. Content is preserved
    verbatim apart from the separator."""
    if isinstance(value, str):
        return value.replace("\r\n", "\n").replace("\r", "\n").replace("\n", " | ").strip()
    return value


def _write(path, columns, rows):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: _flatten(v) for k, v in r.items()})
    return os.path.getsize(path)


def main():
    frappe.set_user("Administrator")
    os.makedirs(OUT, exist_ok=True)

    gl = {p: _gl_rows(p) for p in PERIODS}
    tb = {p: _tb_rows(p) for p in PERIODS}

    print("== sanity checks ==")
    if not sanity(gl, tb):
        raise SystemExit("SANITY CHECKS FAILED — nothing written")

    print("== writing ==")
    for p in PERIODS:
        lo = p.lower()
        size = _write(f"{OUT}/gl_{lo}.csv", GL_COLUMNS, gl[p])
        print(f"  gl_{lo}.csv          {len(gl[p]):6d} rows  {size:>10,} bytes")
        size = _write(f"{OUT}/tb_{lo}.csv", TB_COLUMNS, tb[p])
        print(f"  tb_{lo}.csv          {len(tb[p]):6d} rows  {size:>10,} bytes")

    # Deliberately truncated P2: the tail of the period is missing, so
    # opening + activity no longer equals closing and the gate must hard-block.
    keep = int(len(gl["P2"]) * (1 - TRUNCATE_FRACTION))
    trunc = gl["P2"][:keep]
    size = _write(f"{OUT}/gl_p2_truncated.csv", GL_COLUMNS, trunc)
    dropped = len(gl["P2"]) - keep
    print(f"  gl_p2_truncated.csv {len(trunc):6d} rows  {size:>10,} bytes "
          f"({dropped} rows dropped from the tail)")
    # prove the truncated file actually fails the gate
    tdr = round(sum(float(r["debit"]) for r in trunc), 2)
    fdr = round(sum(float(r["debit"]) for r in gl["P2"]), 2)
    print(f"  truncated P2 debits {tdr:,.2f} vs TB period debits {fdr:,.2f} "
          f"-> delta {fdr - tdr:,.2f} (gate must FAIL)")

    counts()


def counts():
    """Per-period, per-voucher-type counts for the report and export-schema.md."""
    frappe.set_user("Administrator")
    print("== counts ==")
    for period, (start, end) in PERIODS.items():
        rows = frappe.db.sql("""
            SELECT voucher_type, COUNT(DISTINCT voucher_no) vouchers, COUNT(*) gl_rows
            FROM `tabGL Entry`
            WHERE company=%s AND is_cancelled=0 AND posting_date BETWEEN %s AND %s
            GROUP BY voucher_type ORDER BY voucher_type""",
                              (COMPANY, start, end), as_dict=True)
        tot_v = sum(int(r.vouchers) for r in rows)
        tot_r = sum(int(r.gl_rows) for r in rows)
        print(f"  {period}:")
        for r in rows:
            print(f"    {r.voucher_type:20s} vouchers={int(r.vouchers):5d} "
                  f"gl_rows={int(r.gl_rows):5d}")
        print(f"    {'TOTAL':20s} vouchers={tot_v:5d} gl_rows={tot_r:5d}")
        hist = frappe.db.sql("""
            SELECT n, COUNT(*) FROM (
              SELECT voucher_no, COUNT(*) n FROM `tabGL Entry`
              WHERE company=%s AND is_cancelled=0 AND posting_date BETWEEN %s AND %s
              GROUP BY voucher_no) t GROUP BY n ORDER BY n""",
                             (COMPANY, start, end))
        print(f"    lines-per-voucher: {hist}")
