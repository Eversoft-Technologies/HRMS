"""Pull contact details out of resume text, to pre-fill the careers form.

Deterministic heuristics only (no AI call): the endpoint is public, so it must
be cheap and predictable. Everything returned is a suggestion the applicant
sees and can correct before submitting.

    parse_resume_text(text) -> {
        'fullName', 'email', 'phone', 'location', 'linkedinUrl', 'githubUrl',
        'portfolioUrl', 'experienceYears', 'skills': [...],
    }
Missing values are '' (or [] / None).
"""
import re

EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}')
LINKEDIN_RE = re.compile(r'(?:https?://)?(?:[a-z]{2,3}\.)?linkedin\.com/in/([A-Za-z0-9\-_%]{2,100})/?', re.I)
GITHUB_RE = re.compile(r'(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9\-]{1,39})(?![A-Za-z0-9\-/])', re.I)
URL_RE = re.compile(r'https?://[^\s<>"\')]+', re.I)
# +91 98765 43210 · (555) 123-4567 · 098765-43210 · +1-555-123-4567
PHONE_RE = re.compile(r'(?<![\w/(])(\+?\(?\d[\d\s().\-]{8,18}\d)(?![\w/])')
YEARS_RE = re.compile(r'(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+\w+){0,3}\s+experience'
                      r'|experience\s*(?:of|:)?\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)', re.I)
LOCATION_LABEL_RE = re.compile(r'^\s*(?:location|address|current location|based (?:in|at)|city)\s*[:\-–]\s*(.{2,80})$', re.I)

HEADING_WORDS = {
    'resume', 'curriculum', 'vitae', 'cv', 'profile', 'summary', 'objective', 'contact', 'experience',
    'education', 'skills', 'professional', 'career', 'personal', 'details', 'information', 'about', 'me',
    'technical', 'work', 'employment', 'history', 'projects', 'certifications', 'declaration', 'page',
}
TITLE_WORDS = {
    'developer', 'engineer', 'manager', 'analyst', 'consultant', 'designer', 'architect', 'lead', 'intern',
    'senior', 'junior', 'software', 'full', 'stack', 'java', 'python', 'data', 'scientist', 'administrator',
    'tester', 'qa', 'devops', 'specialist', 'associate', 'executive', 'officer', 'director', 'recruiter',
    'student', 'graduate', 'fresher', 'trainee', 'programmer', 'frontend', 'backend', 'web', 'mobile',
}
CITIES = [
    # India
    'Hyderabad', 'Secunderabad', 'Bengaluru', 'Bangalore', 'Chennai', 'Mumbai', 'Navi Mumbai', 'Pune', 'Delhi',
    'New Delhi', 'Gurugram', 'Gurgaon', 'Noida', 'Kolkata', 'Ahmedabad', 'Kochi', 'Cochin', 'Coimbatore',
    'Visakhapatnam', 'Vizag', 'Vijayawada', 'Guntur', 'Warangal', 'Tirupati', 'Nellore', 'Kakinada', 'Rajahmundry',
    'Jaipur', 'Lucknow', 'Indore', 'Bhopal', 'Nagpur', 'Chandigarh', 'Mysuru', 'Mysore', 'Mangaluru', 'Thiruvananthapuram',
    'Trivandrum', 'Madurai', 'Bhubaneswar', 'Patna', 'Ranchi', 'Surat', 'Vadodara', 'Goa',
    # USA
    'New York', 'San Francisco', 'San Jose', 'Seattle', 'Austin', 'Dallas', 'Houston', 'Chicago', 'Boston',
    'Atlanta', 'Los Angeles', 'San Diego', 'Denver', 'Phoenix', 'Charlotte', 'Raleigh', 'Irving', 'Plano',
    'Jersey City', 'Edison', 'Newark', 'Philadelphia', 'Washington', 'Detroit', 'Columbus', 'Minneapolis',
    'Sunnyvale', 'Santa Clara', 'Fremont', 'Redmond', 'Bellevue', 'Miami', 'Tampa', 'Orlando', 'Nashville',
    # elsewhere
    'London', 'Toronto', 'Dubai', 'Singapore', 'Sydney', 'Melbourne',
]
_CITY_RE = re.compile(r'\b(' + '|'.join(re.escape(c) for c in sorted(CITIES, key=len, reverse=True)) + r')\b'
                      r'(\s*,\s*[A-Z][A-Za-z .]{1,30})?', re.I)
SKILLS = [
    'Java', 'Spring Boot', 'Spring', 'Hibernate', 'Microservices', 'Python', 'Django', 'Flask', 'FastAPI',
    'JavaScript', 'TypeScript', 'React', 'Angular', 'Vue', 'Node.js', 'Express', 'Next.js', 'HTML', 'CSS',
    'C#', '.NET', 'C++', 'Go', 'Golang', 'Kotlin', 'Swift', 'PHP', 'Laravel', 'Ruby', 'Rails', 'Scala', 'Rust',
    'SQL', 'MySQL', 'PostgreSQL', 'Oracle', 'MongoDB', 'Redis', 'Elasticsearch', 'Kafka', 'RabbitMQ',
    'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'Git', 'Linux', 'CI/CD',
    'REST', 'GraphQL', 'Selenium', 'JUnit', 'Pandas', 'NumPy', 'TensorFlow', 'PyTorch', 'Machine Learning',
    'Power BI', 'Tableau', 'Salesforce', 'SAP', 'ServiceNow', 'Android', 'iOS', 'Flutter', 'React Native',
]
_SKILL_RES = [(s, re.compile(r'(?<![A-Za-z0-9])' + re.escape(s) + r'(?![A-Za-z0-9])', re.I)) for s in SKILLS]


def _lines(text):
    out = []
    for raw in (text or '').replace('\r', '\n').split('\n'):
        line = re.sub(r'[ \t ]+', ' ', raw).strip(' |•·-–—:\t')
        if line:
            out.append(line)
    return out


def _email(text):
    for m in EMAIL_RE.finditer(text):
        e = m.group(0).strip('.').lower()
        if not e.endswith(('.png', '.jpg', '.jpeg', '.gif')):
            return e
    return ''


def _phone(text):
    for m in PHONE_RE.finditer(text):
        cand = m.group(1).strip()
        digits = re.sub(r'\D', '', cand)
        if not 10 <= len(digits) <= 15:
            continue
        # A date range like 2019 - 2023 2024 is not a phone number.
        if re.fullmatch(r'(?:19|20)\d{2}(?:\D+(?:19|20)\d{2})+', cand.strip()):
            continue
        cand = re.sub(r'\s+', ' ', cand)
        return cand[:40]
    return ''


def _linkedin(text):
    m = LINKEDIN_RE.search(text)
    return 'https://www.linkedin.com/in/' + m.group(1).strip('/') if m else ''


def _github(text):
    m = GITHUB_RE.search(text)
    if not m or m.group(1).lower() in ('features', 'about', 'login', 'orgs'):
        return ''
    return 'https://github.com/' + m.group(1)


def _portfolio(text):
    for m in URL_RE.finditer(text):
        u = m.group(0).rstrip('.,;')
        if not re.search(r'linkedin\.com|github\.com|mailto:', u, re.I):
            return u[:300]
    return ''


def _looks_like_name(line):
    if len(line) < 3 or len(line) > 50 or re.search(r'[@\d/\\|:]', line):
        return False
    words = [w for w in re.split(r'\s+', line) if w]
    if not 2 <= len(words) <= 4:
        return False
    low = {w.lower().strip('.,') for w in words}
    if low & HEADING_WORDS or low & TITLE_WORDS:
        return False
    for w in words:
        if not re.fullmatch(r"[A-Za-z][A-Za-z.'\-]*", w):
            return False
    # Names are capitalised (or all caps); body text is not.
    return all(w[0].isupper() for w in words)


def _name(lines, email):
    for line in lines[:12]:
        # "John Smith | john@x.com | +91 …" — try the first segment of a header line.
        head = re.split(r'\s*[|•·,]\s*|\s{3,}', line)[0].strip()
        for cand in (line, head):
            if _looks_like_name(cand):
                return cand.title() if cand.isupper() else cand
    # Fall back to the email's local part when it reads like first.last.
    local = email.split('@')[0] if email else ''
    parts = [p for p in re.split(r'[._\-]+', re.sub(r'\d+', '', local)) if len(p) > 1]
    if 2 <= len(parts) <= 3:
        return ' '.join(p.capitalize() for p in parts)
    return ''


def _location(lines):
    for line in lines[:40]:
        m = LOCATION_LABEL_RE.match(line)
        if m:
            return m.group(1).strip(' .,')[:200]
    for line in lines[:15]:
        m = _CITY_RE.search(line)
        if m:
            city = m.group(1)
            # Keep the canonical capitalisation from the list.
            city = next((c for c in CITIES if c.lower() == city.lower()), city)
            region = (m.group(2) or '').strip(' ,')
            region = re.split(r'\s{2,}|\s+(?:Phone|Email|Mobile|Tel)\b', region)[0].strip(' ,.') if region else ''
            return (city + (', ' + region if region and len(region) <= 30 else ''))[:200]
    return ''


def _experience_years(text):
    best = None
    for m in YEARS_RE.finditer(text):
        v = m.group(1) or m.group(2)
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if 0 < f <= 45 and (best is None or f > best):
            best = f
    if best is None:
        return None
    return int(best) if best == int(best) else best


def _skills(text, cap=15):
    found = []
    for name, rx in _SKILL_RES:
        if rx.search(text):
            # 'Spring' is implied by 'Spring Boot'; 'Go' only as a whole word already.
            if name == 'Spring' and 'Spring Boot' in found:
                continue
            found.append(name)
        if len(found) >= cap:
            break
    return found


def parse_resume_text(text):
    text = (text or '')[:60000]
    lines = _lines(text)
    email = _email(text)
    return {
        'fullName': _name(lines, email),
        'email': email,
        'phone': _phone(text),
        'location': _location(lines),
        'linkedinUrl': _linkedin(text),
        'githubUrl': _github(text),
        'portfolioUrl': _portfolio(text),
        'experienceYears': _experience_years(text),
        'skills': _skills(text),
    }
