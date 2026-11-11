from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    Image, KeepTogether, HRFlowable
)
from reportlab.lib.utils import ImageReader
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/estate-centric-user-manual.pdf'
LOGO = ROOT / 'public/estate centric logo.png'
SCREENSHOTS = sorted((ROOT / 'public').glob('Screenshot*.png'))
LIVE = ROOT / 'tmp/pdfs'
USERS_SCREEN = LIVE / 'users-module.png'
RE = LIVE / 're'

ORANGE = colors.HexColor('#f56a0a')
NAVY = colors.HexColor('#111827')
MUTED = colors.HexColor('#667085')
LIGHT = colors.HexColor('#f4f6f8')
LINE = colors.HexColor('#d9dee7')
GREEN = colors.HexColor('#147d52')

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='CoverTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=31, leading=37, textColor=NAVY, alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle(name='CoverSub', parent=styles['Normal'], fontSize=14, leading=20, textColor=MUTED, alignment=TA_CENTER, spaceAfter=14))
styles.add(ParagraphStyle(name='H1EC', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=22, leading=26, textColor=NAVY, spaceBefore=4, spaceAfter=9))
styles.add(ParagraphStyle(name='H2EC', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=14, leading=18, textColor=ORANGE, spaceBefore=9, spaceAfter=5))
styles.add(ParagraphStyle(name='BodyEC', parent=styles['BodyText'], fontSize=9.7, leading=14, textColor=colors.HexColor('#273142'), spaceAfter=6))
styles.add(ParagraphStyle(name='SmallEC', parent=styles['BodyText'], fontSize=8, leading=11, textColor=MUTED, spaceAfter=4))
styles.add(ParagraphStyle(name='Callout', parent=styles['BodyText'], fontSize=9.5, leading=14, textColor=NAVY, backColor=colors.HexColor('#fff4e8'), borderColor=colors.HexColor('#ffd1a8'), borderWidth=0.7, borderPadding=8, spaceBefore=5, spaceAfter=8))
styles.add(ParagraphStyle(name='TableHead', parent=styles['BodyText'], fontName='Helvetica-Bold', fontSize=8.5, leading=10, textColor=colors.white))
styles.add(ParagraphStyle(name='TableCell', parent=styles['BodyText'], fontSize=8.2, leading=11, textColor=NAVY))
styles.add(ParagraphStyle(name='Footer', parent=styles['Normal'], fontSize=7.5, textColor=MUTED, alignment=TA_CENTER))

def P(text, style='BodyEC'):
    return Paragraph(text, styles[style])

def bullets(items):
    return [P(f'<b>-</b> {item}', 'BodyEC') for item in items]

def section(title, intro=None):
    out = [P(title, 'H1EC')]
    if intro:
        out.append(P(intro))
    out.append(HRFlowable(width='100%', thickness=1, color=LINE, spaceBefore=1, spaceAfter=9))
    return out

def table(headers, rows, widths):
    data = [[P(x, 'TableHead') for x in headers]]
    data.extend([[P(str(x), 'TableCell') for x in row] for row in rows])
    t = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('GRID', (0, 0), (-1, -1), 0.35, LINE),
        ('BACKGROUND', (0, 1), (-1, -1), colors.white),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, LIGHT]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t

def screenshot(path, width=166*mm):
    if not path.exists():
        return Spacer(1, 1)
    iw, ih = ImageReader(str(path)).getSize()
    h = width * ih / iw
    img = Image(str(path), width=width, height=h)
    img.hAlign = 'CENTER'
    return img

def screenshot_card(path, caption, width=77*mm):
    return [screenshot(path, width), P(caption, 'SmallEC')]

def shots(*items):
    for name, cap in items:
        story.append(KeepTogether([Spacer(1, 4), screenshot(RE / (name + '.png'), 150*mm), P('<b>Screen:</b> ' + cap, 'SmallEC')]))

def header_footer(canvas, doc):
    canvas.saveState()
    w, h = A4
    if doc.page > 1:
        canvas.setFillColor(ORANGE)
        canvas.rect(0, h - 9*mm, w, 9*mm, fill=1, stroke=0)
        canvas.setFillColor(colors.white)
        canvas.setFont('Helvetica-Bold', 8)
        canvas.drawString(18*mm, h - 6*mm, 'ESTATE CENTRIC')
        canvas.setFont('Helvetica', 7.5)
        canvas.drawRightString(w - 18*mm, h - 6*mm, 'Step-by-Step User Guide')
    canvas.setStrokeColor(LINE)
    canvas.line(18*mm, 13*mm, w - 18*mm, 13*mm)
    canvas.setFillColor(MUTED)
    canvas.setFont('Helvetica', 7.5)
    canvas.drawString(18*mm, 8*mm, 'Estate Centric - Internal User Guide')
    canvas.drawRightString(w - 18*mm, 8*mm, f'{doc.page}')
    canvas.restoreState()

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=18*mm, title='Estate Centric Step-by-Step CRM User Guide', author='Estate Centric')
story = []

# Cover
story += [Spacer(1, 22*mm)]
if LOGO.exists():
    story.append(Image(str(LOGO), width=38*mm, height=38*mm, hAlign='CENTER'))
story += [Spacer(1, 8*mm), P('Estate Centric', 'CoverTitle'), P('Step-by-Step CRM User Guide', 'CoverSub')]
story.append(HRFlowable(width=42*mm, thickness=3, color=ORANGE, hAlign='CENTER', spaceBefore=3, spaceAfter=14))
story.append(P('A complete real-estate guide: leads, visits, projects and inventory, allotments, collections, commissions, listings, property management, reports, settings, and security.', 'CoverSub'))
story.append(Spacer(1, 15*mm))
story.append(table(['Guide at a glance', 'What you will learn'], [
    ['Audience', 'Sales teams, property teams, managers, and workspace administrators'],
    ['Core workflow', 'Capture -> assign -> follow up -> visit -> offer -> booking -> collections'],
    ['Admin focus', 'Users, invites, roles, permissions, plans, integrations, and backups'],
], [36*mm, 126*mm]))
story += [Spacer(1, 20*mm), P('Version 2.0 | November 2026', 'SmallEC'), PageBreak()]

# Contents and quick start
story += section('1. Quick start', 'Estate Centric is organized around a simple sales and property workflow. Start with the steps below before exploring advanced setup.')
story += bullets([
    '<b>Sign in.</b> Use your workspace email and password. If your administrator sends an invite, open the one-time link and create your password first.',
    '<b>Set your profile.</b> Open your profile/avatar area and confirm your name, phone, password, and two-factor method.',
    '<b>Learn your scope.</b> Your role controls which leads, contacts, reports, and actions you can see. If something is missing, ask an administrator to check your role and branch/team.',
    '<b>Work from the lead record.</b> Every call, note, follow-up, visit, offer, and booking should be recorded on the lead timeline.',
])
story.append(P('Recommended first-day checklist', 'H2EC'))
story.append(table(['Task', 'Owner', 'Done when...'], [
    ['Confirm phone and profile', 'Every user', 'Your contact details are correct'],
    ['Review assigned leads', 'Agent / counsellor', 'Each open lead has a next action'],
    ['Check dashboard and reports', 'Team lead / manager', 'You know today\'s overdue and SLA items'],
    ['Invite teammates', 'Admin', 'Each teammate has a role, team, branch, and invite link'],
], [64*mm, 35*mm, 63*mm]))
story += [Spacer(1, 10), P('<b>Important:</b> Estate Centric records business activity for accountability. Keep statuses, notes, follow-up dates, and ownership up to date.', 'Callout'), PageBreak()]

# Step-by-step workflows
story += section('Step-by-step user guide', 'Follow these workflows in order. The labels match the main navigation and buttons in the application.')
story.append(P('1. Daily lead workflow', 'H2EC'))
story.append(table(['Step', 'Action', 'Check before moving on'], [
    ['1', 'Open Dashboard and review new, overdue, and unassigned leads.', 'No urgent lead is missed.'],
    ['2', 'Open Leads and search by name, phone, email, or project before creating a record.', 'No duplicate contact exists.'],
    ['3', 'Create or open the lead and complete name, phone, source, project, budget, and type.', 'Required details are complete.'],
    ['4', 'Assign the lead to the correct owner, team, and branch.', 'An owner is visible.'],
    ['5', 'Log the call, WhatsApp, email, or visit outcome and set the next follow-up date.', 'Timeline has an activity and next action.'],
    ['6', 'Move the lead through Contacted, Qualified, Visit Scheduled, Negotiation, and Booked or Lost.', 'Status matches the real conversation.'],
    ['7', 'At day end, open Reports or Users > Performance and review leads, calls, visits, bookings, and overdue work.', 'No open lead is left without a next step.'],
], [13*mm, 90*mm, 59*mm]))
shots(('dashboard', 'Dashboard: start the day with KPIs, overdue and unassigned leads.'),('leads', 'Leads: board view with filters, import and export.'),('lead-new', 'New lead form: name, phone, source, project, budget and assignment.'),('lead-detail', 'Lead detail: log activity, change status, record offers and see the timeline.'))
story.append(P('2. Property and project workflow', 'H2EC'))
story.append(table(['Step', 'Action', 'Check before moving on'], [
    ['1', 'Open Projects or Properties and select the correct project, society, or property.', 'You are working in the right workspace scope.'],
    ['2', 'Add or update the record with title, location, type, price, status, owner, and supporting files.', 'The record is complete and saved.'],
    ['3', 'For a society map, upload the plan, remove white background if needed, adjust or fit the map, and save.', 'The map stays aligned when zooming.'],
    ['4', 'Use Redraw boundary or Match points only when the visible boundary needs correction.', 'The boundary follows the approved plan.'],
    ['5', 'Link the project or property to relevant leads and continue follow-up from the lead timeline.', 'The sales context is connected.'],
], [13*mm, 90*mm, 59*mm]))
shots(('projects', 'Projects: pick the project you are working in.'),('project-inventory', 'Inventory grid: colour-coded unit status by block.'),('property-detail', 'Property page: owner, tenant, lease, owner statement and maintenance.'))
story += [PageBreak()]

story += section('Step-by-step: administration and reporting', 'Administrators use these workflows to keep access, ownership, imports, and performance reporting accurate.')
story.append(P('3. Invite a user and set permissions', 'H2EC'))
story.append(table(['Step', 'Action', 'Check before moving on'], [
    ['1', 'Open Users from the administration area and choose Invite user or Create account.', 'The invitation form is open.'],
    ['2', 'Enter the user name and email, then choose the role, branch, team, and account scope.', 'The user is assigned to the correct account.'],
    ['3', 'Set permissions for leads, projects, properties, reports, settings, and map editing.', 'Access follows the user\'s job.'],
    ['4', 'Send the invite link and ask the user to create a password from the one-time link.', 'The user can sign in.'],
    ['5', 'Return to Users and confirm the user is active, correctly scoped, and not an administrator by mistake.', 'Role and account ownership are correct.'],
], [13*mm, 90*mm, 59*mm]))
shots(('users', 'Users: roles, teams, branches and plans for each account.'))
story.append(P('4. Import and export leads', 'H2EC'))
story.append(table(['Step', 'Action', 'Check before moving on'], [
    ['1', 'Open Leads and choose Export to download the current filtered or full lead list.', 'The CSV or XLSX file opens with column headers.'],
    ['2', 'Prepare an import file with one lead per row. Keep headers such as name, phone, email, source, project, status, owner, and notes.', 'Columns use consistent names and formats.'],
    ['3', 'Choose Import and upload CSV or XLSX. Review the preview and map any unmatched columns.', 'The preview shows the expected number of rows.'],
    ['4', 'Run the validation or dry run first, then confirm the import.', 'Required-field and duplicate warnings are understood.'],
    ['5', 'After import, search a sample of records and check ownership, status, project, and timeline data.', 'Imported records are visible and usable.'],
], [13*mm, 90*mm, 59*mm]))
shots(('import', 'Import leads: upload a CSV and review the dry-run report.'))
story.append(P('5. Review team performance', 'H2EC'))
story.append(table(['Step', 'Action', 'Check before moving on'], [
    ['1', 'Open Users and select the Performance tab.', 'The user directory and metrics are visible.'],
    ['2', 'Choose the date and optionally search or filter active users.', 'The review period is correct.'],
    ['3', 'Compare daily leads, total leads, open leads, contacted rate, calls, visits, bookings, and sales.', 'Counts are read in context, not in isolation.'],
    ['4', 'Open the underlying lead records for overdue or unusually low activity.', 'Coaching or reassignment has a clear reason.'],
    ['5', 'Record the next action for each team member and review again at the next check-in.', 'Performance follow-up is documented.'],
], [13*mm, 90*mm, 59*mm]))
shots(('users-performance', 'Users > Performance: daily metrics for each team member.'))
story.append(P('Weekly admin checklist: verify invitations and permissions, review imports and duplicates, check account-specific data access, inspect user performance, and confirm that backups and integrations are healthy.', 'Callout'))
story += [PageBreak()]

# Complete step-by-step coverage of every remaining module
def steps(title, rows, imgs=()):
    story.append(P(title, 'H2EC'))
    story.append(table(['Step', 'Action', 'Check before moving on'], [[str(i + 1), a, c] for i, (a, c) in enumerate(rows)], [13*mm, 90*mm, 59*mm]))
    shots(*imgs)

story += section('Step-by-step: sales, inventory and collections', 'The full path from a unit hold to a receipted payment. Collections and Sales appear only for roles with the matching permission.')
steps('7. Visits: schedule, verify and close', [
    ('Open Visits and create a visit from the lead, choosing site, date, time and agent.', 'The visit shows on the lead timeline.'),
    ('On arrival the agent checks in. GPS must be within the site radius set in Settings > Site visits.', 'Check-in is verified, not flagged unverified.'),
    ('Ask the customer for the SMS OTP to confirm they attended.', 'OTP accepted.'),
    ('Enter the mandatory feedback within the feedback window and close the visit.', 'No overdue-feedback flag remains.'),
], imgs=[('visits', 'Visits: scheduled site visits with customer, site, agent and status.')])
steps('8. Hold, book and allot a unit', [
    ('Open Projects, choose the project, then Inventory (Grid or Map). Filter by block, size or status.', 'You see live unit status colours.'),
    ('Place a Hold on the unit. Holds expire automatically and each agent has a hold limit (Settings > Inventory).', 'Unit shows Held and no one else can book it.'),
    ('Create the booking against the lead. The unit becomes Booked and the lead moves to Booked together.', 'Unit and lead status agree.'),
    ('Open Allotments, review the allotment and print the Booking form (applicant, nominee, plan, CNIC copies).', 'Form is complete and signed.'),
    ('Use Sizes & prices for versioned price lists, premiums and marla/kanal/sq ft conversion; Media for brochures, floor plans, photos and video links.', 'Pricing matches the approved list.'),
], imgs=[('project-inventory', 'Inventory: click a unit to hold or allot it.'), ('project-allotments', 'Allotments: every sold unit with client, price, letter, ledger and cancel actions.'), ('project-sizes', 'Sizes & prices: price lists, premiums and unit counts.'), ('project-media', 'Media: brochures, floor plans, photos and video links.'), ('allotment', 'Allotment letter ready to print.'), ('booking-form', 'Booking form: applicant, nominee and CNIC copies.')])
steps('9. Collections: payment plan, receipts and ledger', [
    ('Open Collections and find the allotment (overdue and plan-less allotments are listed first).', 'The right customer is selected.'),
    ('Create the payment plan: down payment plus monthly, quarterly, half-yearly or yearly installments.', 'Installment schedule is shown.'),
    ('Record each payment with method and date. A printable receipt (RC-00001 series) is generated.', 'Receipt number is issued.'),
    ('If a payment was entered wrongly, Void it with a reason; use Refund for returned money.', 'Reason is recorded and ledger updates.'),
    ('Open the customer ledger; payments are applied to the oldest installment first. Share the portal link on WhatsApp so the customer can view plots, schedule, overdue and receipts without logging in.', 'Overdue status is correct.'),
    ('For a resale, use Transfer to a new owner with a receipted transfer fee.', 'New owner is on the allotment.'),
], imgs=[('collections', 'Collections: overdue and plan-less allotments with sold value, collected and outstanding.'), ('ledger', 'Customer ledger: payment schedule with Paid, Partial and Due status.'), ('receipt', 'Printable payment receipt (RC series).')])
steps('10. Sales, commissions, dealers and targets', [
    ('Open Sales. Add external dealers with their own rate or use the default (agent 1% / dealer 2%, editable in Settings > Commission).', 'Dealer list is current.'),
    ('Tag the dealer on the lead before the booking. Commission is created automatically at allotment for the agent and dealer.', 'Pending commission exists.'),
    ('Review pending commissions; adjust or cancel with a reason. Mark paid when released.', 'Status is Paid and dealer balance updates.'),
    ('If a sale is cancelled, pending commission is cancelled and a paid one is flagged for recovery.', 'Recovery items are followed up.'),
    ('Use the Performance view to compare monthly targets against sales and conversion per agent. Agents see only their own figures.', 'Targets are set for the month.'),
], imgs=[('sales', 'Sales: agent targets, pending commissions and dealers.'), ('settings-sales', 'Settings > Commission: default agent and dealer rates.')])
steps('11. Third-party listings', [
    ('Open Listings and add a resale or rental listing from an outside owner with details and up to 12 photos.', 'The owner is saved as a seller or landlord lead.'),
    ('Update listing status as it progresses (statuses are configurable in Settings > Inventory).', 'Status is current.'),
    ('Share the listing to WhatsApp for buyers or tenants.', 'Message contains the listing link.'),
], imgs=[('listings', 'Listings: sale and rent listings from outside owners.')])
steps('12. Property management: leases, rent and owners', [
    ('Open Properties > Societies and draw the society, phase or block boundary; upload the plan image and align it by matching 2+ points.', 'The overlay lines up with the satellite map.'),
    ('Switch to Properties and click the map to add a property. It takes the society, phase and block it falls in.', 'Pin is inside the right area.'),
    ('Add owner and tenant (one-tap call or WhatsApp) and create the lease with rent, deposit, yearly increase, police registration and agreement number.', 'Lease dates and rent are correct.'),
    ('Track the monthly rent schedule. Record rent, deposit and refund receipts (RR-00001 series). Overdue arrears carry over on renewal.', 'Schedule shows what is paid.'),
    ('Use Renew, Edit or Tenant moved out as the lease changes; amber and red colours warn of lease ending and overdue rent.', 'Map colour matches reality.'),
    ('Log maintenance jobs charged to owner, tenant or company, then review the owner statement (rent minus fee, owner costs and payouts) and record payouts.', 'Statement balances.'),
], imgs=[('property-detail', 'Property page: lease, rent schedule, owner statement and maintenance.'), ('rent-receipt', 'Rent or deposit receipt (RR series).')])
steps('13. Import, campaigns and lead capture', [
    ('Open Import (permission required), upload CSV and run the dry run to review duplicates and invalid rows.', 'Dry-run report is clean.'),
    ('Commit the import, then spot-check ownership, status and timelines.', 'Records are usable.'),
    ('Open Campaigns to see Meta campaign, ad set and ad performance by lead, plus other lead sources.', 'Source quality is understood.'),
    ('Connect Facebook/Instagram in Settings (paste app secret and Graph API Explorer token; the CRM registers the webhook), and use Website forms & API with the x-api-key header for forms, Zapier and portals.', 'Test lead arrives with its source.'),
], imgs=[('import', 'Import leads.'), ('campaigns', 'Campaigns: leads, wins and conversion per campaign.'), ('settings-facebook', 'Settings > Facebook & Instagram: connect lead ads.'), ('settings-website', 'Settings > Website forms & API: endpoint, key and sample request.')])
steps('14. Approvals, exports and the audit log', [
    ('A lead marked Lost or Junk needs a reason and note; a team lead approves where required (Leads > Pending approval).', 'Approval queue is empty.'),
    ('Branch managers request a lead export; the sales head or admin approves. Each approval downloads once and the file is watermarked.', 'Export is logged.'),
    ('Admins open Audit to review logins, views, exports and changes. The log is append-only and cannot be edited.', 'Unusual access is investigated.'),
], imgs=[('leads', 'Leads filters include Pending approval.'), ('audit', 'Audit: append-only log of logins, views, exports and changes.')])
story += [PageBreak()]

story += section('Step-by-step: workspace setup and everyday tools', 'Settings are grouped into Account, Integrations and Company. Admins see all groups; other roles see what their permissions allow.')
steps('15. Set up a new workspace (first week)', [
    ('Sign up from the login page and choose a plan. The free trial lasts 7 days; an admin is never locked out.', 'You can sign in.'),
    ('Settings > Profile and Privacy & security: confirm details, change the default password (10+ characters with letters and numbers) and enable authenticator-app 2FA.', '2FA is active.'),
    ('Settings > Leads & pipeline: set statuses, closed and approval statuses, lost reasons, sources, activity types, lead and property types, custom fields, stale days and scoring.', 'Pipeline matches how you sell.'),
    ('Settings > Assignment & SLA: add prioritised assignment rules (source, city, project, budget, hours, round-robin, load or performance), SLA minutes and working hours.', 'New lead routes to the right agent.'),
    ('Settings > Site visits, Inventory & listings, Properties & leases, and Commission: configure the lists and limits each module uses.', 'Defaults reviewed.'),
    ('Settings > Maps: paste the MapTiler key. Settings > Email reports: choose weekly report recipients and send a preview.', 'Map loads; preview received.'),
    ('Settings > Roles & permissions: tick what each role can do. Users: invite the team and set role, team and branch.', 'Everyone has the least access needed.'),
    ('Check plan limits (users, branches, projects, units, leads) shown on Users before adding more.', 'You stay under the cap.'),
], imgs=[('settings', 'Settings > Profile.'), ('settings-security', 'Settings > Privacy & security: two-factor and password.'), ('settings-leads', 'Settings > Leads & pipeline: statuses, reasons, sources and custom fields.'), ('settings-assignment', 'Settings > Assignment & SLA: rules, SLA minutes and working hours.'), ('settings-inventory', 'Settings > Inventory & listings.'), ('settings-maps', 'Settings > Maps: add the map key.'), ('settings-permissions', 'Settings > Roles & permissions: what each role can do.')])
steps('16. Everyday tools: dashboard, reports, assistant, mobile', [
    ('Dashboard tabs: Main, Team and Marketing. Filter by date to see KPIs, funnel, leaderboard, source and campaign table, and lost reasons.', 'You know today\'s priorities.'),
    ('Reports: switch daily, weekly (Mon-Sun) or monthly, drill into one agent for a day-by-day view, then use CSV or Print.', 'Numbers match the period.'),
    ('Assistant (enabled when an AI key is configured): ask about sales, agents and commissions; it only sees data your role already sees.', 'Answer matches the dashboard.'),
    ('Use the mobile bottom bar for Dashboard, Leads, Projects and Visits; open More for Sales, Listings, Import, Campaigns, Users, Settings and Audit. Install the app to your home screen from the browser prompt.', 'App opens full screen.'),
    ('Forgot password: request a reset; an admin sends a one-time link that expires in 30 minutes and signs the account out everywhere.', 'New password works.'),
], imgs=[('dashboard', 'Dashboard.'), ('reports', 'Reports: daily, weekly or monthly figures per agent, with CSV and print.')])
story += [PageBreak()]

# Screen tour
story += section('Screen tour', 'These screens show where the main workflows live. Your workspace may show additional modules depending on your role, plan, and enabled products.')
screen_rows = [
    [screenshot_card(SCREENSHOTS[0], '<b>Dashboard:</b> start here for KPIs, pipeline, agent activity, and overdue work.'), screenshot_card(SCREENSHOTS[1], '<b>Leads:</b> manage the pipeline, search, filters, imports, and exports.')],
    [screenshot_card(SCREENSHOTS[2], '<b>Reports:</b> review daily, weekly, and monthly team performance.'), screenshot_card(SCREENSHOTS[3], '<b>Settings:</b> configure profile, integrations, maps, roles, and permissions.')],
]
screen_table = Table(screen_rows, colWidths=[82*mm, 82*mm], hAlign='CENTER')
screen_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4), ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
story.append(screen_table)
story.append(PageBreak())
story += section('Screen tour: lead detail', 'The lead detail page is the source of truth for customer history and next actions.')
story.append(screenshot(SCREENSHOTS[4], 155*mm))
story.append(P('Lead detail example: log activity, update status, set the next action, and keep the record owner and customer contact visible.', 'SmallEC'))
story.append(P('Tip: when handing a lead to another teammate, leave a clear note explaining the customer need, last conversation, promised follow-up, and any documents still needed.', 'Callout'))
story.append(PageBreak())

# Module-by-module guide
story += section('Module-by-module guide', 'Use this section as the practical training path. Open the module shown in the left navigation, complete the action, and save the record before moving on.')
story.append(table(['Module', 'What the user does', 'Main result'], [
    ['Dashboard', 'Review KPIs, overdue work, pipeline, and team activity', 'Know what needs attention today'],
    ['Leads / Lead detail', 'Create, qualify, assign, contact, and schedule next action', 'Every opportunity has an owner and next step'],
    ['Projects / Inventory', 'Maintain projects, phases, blocks, units, pricing, holds, and bookings', 'Availability and booking status stay current'],
    ['Properties / Maps', 'Draw boundaries, upload overlays, place properties, and manage leases', 'Map and property records remain aligned'],
    ['Visits', 'Schedule, check in, record feedback, and close the visit', 'Visits become measurable sales activity'],
    ['Collections / Payments', 'Record receipts, installments, rent, refunds, and owner payouts', 'Financial history is auditable'],
    ['Reports', 'Filter daily, weekly, or monthly performance and export approved reports', 'Managers can act on reliable numbers'],
    ['Users / Settings', 'Invite users, set roles, permissions, integrations, and security', 'Access follows the company structure'],
], [42*mm, 70*mm, 56*mm]))
story.append(P('Screenshot note', 'H2EC'))
story.append(P('Screens are captured from the current Estate Centric interface. Menu visibility depends on the account modules and role; a user may see fewer modules than the full manual.', 'Callout'))
story += [PageBreak()]

story += section('Module screens: property CRM', 'These screens cover the core real-estate workflow from daily overview through map and administration.')
property_cards = [
    [screenshot_card(RE / 'dashboard.png', '<b>Dashboard:</b> review the daily pulse, overdue items, funnel, and agent activity.', 77*mm), screenshot_card(SCREENSHOTS[1], '<b>Leads:</b> filter the pipeline, update status, and open a lead record.', 77*mm)],
    [screenshot_card(SCREENSHOTS[4], '<b>Lead detail:</b> record calls, notes, status, offer information, and the next action.', 77*mm), screenshot_card(USERS_SCREEN, '<b>Users:</b> assign roles, teams, branches, plans, and account access.', 77*mm)],
]
property_table = Table(property_cards, colWidths=[82*mm, 82*mm], hAlign='CENTER')
property_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4), ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
story.append(property_table)
story.append(PageBreak())

story += section('Module screens: operations and management', 'Managers use these screens to monitor performance, configure access, and keep the workspace safe.')
ops_cards = [
    [screenshot_card(RE / 'reports.png', '<b>Reports:</b> switch daily/weekly/monthly views, review team rows, and use approved export/print actions.', 77*mm), screenshot_card(SCREENSHOTS[3], '<b>Settings:</b> configure profile, integrations, maps, permissions, and system rules.', 77*mm)],
    [screenshot_card(RE / 'collections.png', '<b>Collections reference:</b> confirm receipt workflow and balance collection before closing a financial item.', 77*mm), screenshot_card(SCREENSHOTS[0], '<b>Management dashboard:</b> use KPIs to choose the next coaching or follow-up action.', 77*mm)],
]
ops_table = Table(ops_cards, colWidths=[82*mm, 82*mm], hAlign='CENTER')
ops_table.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4), ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
story.append(ops_table)
story.append(P('For Properties, Projects, Visits, and Collections, use the step-by-step instructions in the next chapters. These modules are permission-gated, so the exact menu appears only when enabled for the account.', 'Callout'))
story += [PageBreak()]

# Navigation
story += section('2. Navigation and permissions', 'The left navigation changes according to your enabled modules and permissions.')
story.append(table(['Area', 'Use it for'], [
    ['Dashboard', 'KPI summary, funnel, response time, sources, agents, visits, and overdue work'],
    ['Leads', 'Board/table pipeline, search, assignments, activities, imports, and exports'],
    ['Properties', 'Societies, boundaries, rental properties, leases, rent, maintenance, and owner statements'],
    ['Projects / inventory', 'Projects, phases, blocks, units, pricing, holds, allotments, and map inventory'],
    ['Visits', 'Schedule, check-in, customer OTP, feedback, and unverified visits'],
    ['Reports', 'Agent performance, sales, collections, commissions, and print/CSV output'],
    ['Settings', 'Company rules, integrations, maps, roles, permissions, reports, and security'],
], [43*mm, 119*mm]))
story.append(P('Role model', 'H2EC'))
story += bullets([
    '<b>Role:</b> controls lead visibility and available actions. Common roles include Agent, Team lead, Branch manager, Sales head, Owner, and Admin.',
    '<b>Team and branch:</b> refine assignment and reporting scope. Keep them accurate so routing and reports remain reliable.',
    '<b>Permission matrix:</b> administrators can decide which roles may import, export, manage users, edit inventory, approve lost leads, manage payments, and change settings.',
])
story.append(P('If you cannot see a menu item or button, it is usually a permission, module, plan, or account-scope setting - not a browser problem.', 'Callout'))
story += [PageBreak()]

# Leads
story += section('3. Leads: the daily operating workflow', 'Leads are the center of the CRM. Keep the record complete so the next person can understand the customer and take action.')
story.append(P('Create and qualify a lead', 'H2EC'))
story += bullets([
    'Select <b>Leads</b>, then choose <b>+ New lead</b>. Capture name, phone, source, project, budget, purpose, and any custom fields.',
    'Search before creating a duplicate. The CRM normalizes phone numbers and can attach repeat inquiries to an existing open lead.',
    'Assign the lead to the correct agent or let the assignment rules route it by source, city, project, budget, team, branch, working hours, or load.',
    'Set a next follow-up date for every active lead. The SLA clock uses first-contact and follow-up activity to surface risk.',
])
story.append(P('Lead status discipline', 'H2EC'))
story.append(table(['When this is true', 'Use this action'], [
    ['New inquiry received', 'Keep New and make the first contact'],
    ['Conversation started', 'Log a call/note and move to Contacted'],
    ['Customer is a fit', 'Move to Qualified and record needs/budget'],
    ['Visit or meeting is agreed', 'Create a Visit with location and time'],
    ['Offer or price discussion started', 'Record an Offer and keep next action current'],
    ['No further opportunity', 'Use Lost/Junk with a reason; approvals may be required'],
], [67*mm, 95*mm]))
story.append(P('Import and export', 'H2EC'))
story += bullets([
    'Use <b>Import leads</b> for CSV/XLSX files. Start with a dry run to review duplicates, invalid rows, and fields before committing.',
    'Use CSV or XLSX export only when your role has permission. Export requests may require approval from a sales head or administrator.',
    'Protect downloaded files: they contain customer data and may be watermarked or audited.',
])
story += [PageBreak()]

# Users/admin
story += section('4. Users, invites, roles, and permissions', 'Administrators should manage access through invitations and roles instead of sharing passwords.')
story.append(P('Invite a user', 'H2EC'))
story += bullets([
    'Open <b>Users</b> and choose <b>Invite user</b> / <b>Create account</b>. Enter name, email, phone, role, team, and branch.',
    'Leave the password blank to generate an invitation. The user receives a one-time setup link when email delivery is configured.',
    'If email is not configured, copy the generated invite link and send it through an approved channel. The link expires after 30 minutes and works once.',
    'Use <b>Invite link</b> on an existing user to generate a fresh setup link. Deactivated users must be activated first.',
])
story.append(P('Assign the right access', 'H2EC'))
story.append(table(['Role', 'Typical use'], [
    ['Agent', 'Own leads, calls, visits, offers, and assigned follow-ups'],
    ['Team lead', 'Team visibility, coaching, assignment support, and approvals available to the role'],
    ['Branch manager', 'Branch-level visibility and operational reporting'],
    ['Sales head / Owner', 'Company-wide sales oversight and approval workflows'],
    ['Admin', 'Users, settings, permissions, integrations, and full workspace administration'],
], [43*mm, 119*mm]))
story.append(P('Account isolation', 'H2EC'))
story.append(P('Users, projects, properties, overlays, and other account-owned records are scoped to the workspace that created them. A user added under the main account inherits the company workspace and its enabled modules; unrelated accounts do not appear in the Users page.', 'BodyEC'))
story.append(P('Security rule: never send a password in a shared spreadsheet or chat. Use the one-time invite/reset link.', 'Callout'))
story += [PageBreak()]

# Projects and maps
story += section('5. Projects, inventory, and maps', 'Use Projects for land/building inventory and Properties for managed real estate and map-based property work.')
story.append(P('Project inventory workflow', 'H2EC'))
story += bullets([
    'Create the project, then add phases, blocks, streets, units, pricing, categories, and premiums.',
    'Use the inventory map to view live unit status. Holds expire automatically according to your settings.',
    'When a booking is created, the unit status and lead status update together. Keep the customer ledger and allotment documents attached.',
    'Use media for brochures, floor plans, photos, and shareable project links.',
])
story.append(P('Society and property map workflow', 'H2EC'))
story += bullets([
    'Open <b>Properties -> Societies</b> and draw or edit the society/phase/block boundary.',
    'Click the map to add a property pin. The CRM determines the containing society/phase/block when the point falls inside a boundary.',
    'Upload a plan image, remove white background when needed, adjust opacity, fit the map, match points, and redraw boundaries when the outline is incorrect.',
    'Click the uploaded map to open the overlay controls. Use Hide map, Reset position, Fit entire map, Redraw boundary, and Delete carefully.',
])
if SCREENSHOTS[1].exists():
    story.append(screenshot(SCREENSHOTS[1], 155*mm))
    story.append(P('Example interface view - the Leads board shows status columns, filters, search, and export controls.', 'SmallEC'))
story += [PageBreak()]

# Properties, collections, reports
story += section('6. Properties, collections, and reports', 'The property and collections tools keep ownership, leases, rent, payments, and sales performance together.')
story.append(P('Managed property workflow', 'H2EC'))
story += bullets([
    'Create or select a society, then add the property from the map with owner and tenant details.',
    'Create the lease with rent, deposit, dates, yearly increase, police registration, and agreement number.',
    'Review rent schedule and overdue items from the property or Collections area. Record receipts, refunds, maintenance, and owner payouts.',
    'Use status colours on the map to identify vacant, let, ending, or overdue properties.',
])
story.append(P('Reports', 'H2EC'))
story.append(table(['Report', 'Best used for'], [
    ['Dashboard', 'Daily pulse: funnel, SLA, source, agent, visit, and overdue indicators'],
    ['Agent report', 'Daily/weekly/monthly productivity, response time, calls, visits, bookings, sales, and commission'],
    ['Collections', 'Overdue rent, installment plans, receipts, payments, refunds, and transfers'],
    ['Commissions', 'Pending, paid, cancelled, dealer balances, and agent targets'],
    ['Weekly email report', 'Management summary; configure in Settings when email delivery is connected'],
], [48*mm, 114*mm]))
story += [PageBreak()]

# Integrations
story += section('7. Integrations and data capture', 'Connect the channels your team already uses, then confirm every inbound record is visible in the CRM.')
story.append(P('Facebook and Instagram leads', 'H2EC'))
story += bullets([
    'Open <b>Settings -> Facebook & Instagram</b> and enter the Meta app details, verification token, app secret, and Page token as configured by your administrator.',
    'Confirm the webhook callback and test delivery. Campaign, ad set, and ad identifiers are stored with the lead when provided by Meta.',
    'Review recent deliveries in Settings. A rejected lead should show a reason rather than failing silently.',
])
story.append(P('Website and inbound API', 'H2EC'))
story += bullets([
    'Use Settings -> Website forms & API for the inbound endpoint and API key.',
    'Send a name plus at least one contact method, then include source, campaign, project, budget, and notes when available.',
    'Treat inbound keys like passwords. Rotate them if they are exposed.',
])
story.append(P('Email and SMS expectations', 'H2EC'))
story.append(P('Some installations use console stubs until an SMTP/email API or local SMS gateway is connected. If an invite link is generated but email is not marked as sent, copy the link and deliver it manually while the integration is being configured.', 'BodyEC'))
story += [PageBreak()]

# Security and troubleshooting
story += section('8. Security, backups, and troubleshooting', 'Good data hygiene protects customer information and prevents operational confusion.')
story.append(P('Security checklist', 'H2EC'))
story += bullets([
    'Use a unique password with at least 10 characters and letters plus numbers.',
    'Enable two-factor login from your security settings. Administrators can reset 2FA for a user who loses access.',
    'Deactivate offboarded users promptly. Their sessions end and open leads can be reassigned.',
    'Do not share exports, invite links, API keys, customer CNICs, or portal links outside approved channels.',
    'Keep regular backups of your workspace data and restrict backup downloads to administrators.',
])
story.append(P('Common problems', 'H2EC'))
story.append(table(['Problem', 'What to check'], [
    ['Cannot see a lead or property', 'Role scope, branch/team, account, active status, and module permissions'],
    ['Invite email did not arrive', 'Email integration, spam folder, correct address; copy the one-time link from Users'],
    ['Map overlay looks cut or misaligned', 'Fit entire map, reset position, opacity, white-background option, match points, redraw boundary'],
    ['3D or map view does not load', 'Browser refresh, MapTiler key, deployment API health, and browser console/network errors'],
    ['Import rejects rows', 'Run dry-run first; correct required fields, phone format, duplicate rows, and headers'],
    ['User sees the wrong role', 'Refresh session, check Users role dropdown, verify account owner, and log in again'],
], [59*mm, 103*mm]))
story.append(P('Deployment check', 'H2EC'))
story.append(P('Administrators can check <b>/api/health</b> after deployment. A healthy response confirms the API and database connection. If the response is a 500, inspect the deployment environment variables and database credentials before changing application data.', 'Callout'))
story += [PageBreak()]

# Appendix
story += section('Appendix: recommended operating rhythm')
story.append(table(['Frequency', 'Team habit'], [
    ['Every morning', 'Review dashboard, overdue follow-ups, new leads, visits, and assignments'],
    ['After every contact', 'Log the activity, result, next action, and next action date'],
    ['Before a visit', 'Confirm location, customer phone, assigned agent, and visit status'],
    ['After an offer', 'Record amount, terms, documents, and the next decision date'],
    ['At booking', 'Confirm unit status, allotment, payment plan, receipt, and customer documents'],
    ['Every week', 'Review SLA breaches, source quality, agent response time, lost reasons, and collections'],
    ['Every month', 'Review commissions, targets, branch performance, plan limits, users, and backups'],
], [43*mm, 119*mm]))
story.append(Spacer(1, 12))
story.append(P('Need help?', 'H2EC'))
story.append(P('Contact your Estate Centric workspace administrator first. Include the page, user email, approximate time, and a screenshot of the issue. Never include passwords, API keys, or private customer documents in a support request.', 'BodyEC'))
story.append(Spacer(1, 20))
story.append(P('Estate Centric - turning property conversations into accountable workflows.', 'CoverSub'))

OUT.parent.mkdir(parents=True, exist_ok=True)
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(OUT)
