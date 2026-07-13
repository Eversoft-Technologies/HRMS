"""
Job Form Builder API
--------------------------------------------------------------------------
Backs the no-code Job Form Builder: a dynamic form schema, reusable templates,
global master-data (shared dropdown option lists) and a world-currency catalogue.

Endpoints (all JSON):
  GET/POST   /api/job-form/config            active form schema (get / save)
  GET/POST   /api/job-form/templates         list / create reusable templates
  GET/PUT/DELETE /api/job-form/templates/<id>  load / update / activate / delete
  GET/POST   /api/master-data                list / upsert option sets
  PUT/DELETE /api/master-data/<key>          edit / delete an option set
  GET        /api/currencies                 ISO-4217 world currencies

Writes are ungated (like the rest of this API, identity travels in the request);
tighten with require_perm('settings.manage') if stricter control is needed.
"""
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from api.models import JobFormTemplate, MasterDataSet


def _err(msg, code=400):
    return Response({'error': msg}, status=code)


# ── default seed data ──────────────────────────────────────────────────────
DEFAULT_MASTER_DATA = [
    {'key': 'departments', 'label': 'Departments', 'options': [
        'Engineering', 'Product', 'Design', 'Data & Analytics', 'Sales',
        'Marketing', 'Human Resources', 'Finance', 'Operations',
        'Customer Success', 'Legal', 'IT & Security']},
    {'key': 'locations', 'label': 'Locations', 'options': [
        'Hyderabad', 'Bengaluru', 'Mumbai', 'Delhi NCR', 'Chennai', 'Pune',
        'Remote — India', 'Remote — Global', 'New York', 'London', 'Singapore', 'Dubai']},
    {'key': 'job_types', 'label': 'Job Types', 'options': [
        'Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary', 'Freelance']},
    {'key': 'priorities', 'label': 'Priorities', 'options': [
        'Critical', 'High', 'Medium', 'Normal', 'Low']},
    {'key': 'statuses', 'label': 'Job Statuses', 'options': [
        'Active', 'On Hold', 'Closed', 'Filled', 'Cancelled', 'Draft']},
    {'key': 'experience_levels', 'label': 'Experience Levels', 'options': [
        'Entry Level', 'Junior', 'Mid Level', 'Senior', 'Lead', 'Principal',
        'Manager', 'Director']},
    {'key': 'education_levels', 'label': 'Education Levels', 'options': [
        'High School', 'Diploma', "Bachelor's Degree", "Master's Degree",
        'PhD', 'Any Graduate', 'Not Required']},
    {'key': 'skills', 'label': 'Skills', 'options': [
        'Python', 'JavaScript', 'React', 'Django', 'SQL', 'AWS', 'Docker',
        'Kubernetes', 'Java', 'Communication', 'Leadership', 'Project Management']},
]


def _field(key, label, ftype, **kw):
    d = {
        'id': 'f_' + key, 'key': key, 'label': label, 'type': ftype,
        'required': kw.get('required', False),
        'placeholder': kw.get('placeholder', ''),
        'help': kw.get('help', ''),
        'width': kw.get('width', 'full'),
        'core': kw.get('core', False),
    }
    for opt in ('masterKey', 'options', 'defaultValue', 'conditional'):
        if opt in kw:
            d[opt] = kw[opt]
    if kw.get('currency'):
        d['currency'] = True
    return d


# Default form, grouped into sections (matches the builder's section model).
DEFAULT_SECTIONS = [
    {'id': 'sec_details', 'title': 'Job Details', 'collapsed': False, 'fields': [
        _field('title', 'Job Title', 'text', required=True, placeholder='e.g. Senior Data Analyst', core=True),
        _field('dept', 'Department', 'select', required=True, placeholder='Select Department', masterKey='departments', core=True, width='half'),
        _field('location', 'Location', 'select', required=True, placeholder='Select Location', masterKey='locations', core=True, width='half'),
        _field('type', 'Job Type', 'select', required=True, placeholder='Select Job Type', masterKey='job_types', defaultValue='Full-time', core=True, width='half'),
        _field('experience', 'Experience (Years)', 'number', required=True, placeholder='e.g. 3', width='half'),
        _field('salary', 'Salary Range', 'salary', currency=True, core=True),
        _field('description', 'Job Description', 'textarea', required=True, placeholder='Enter job description…', core=True),
    ]},
    {'id': 'sec_reqs', 'title': 'Requirements', 'collapsed': False, 'fields': [
        _field('skills', 'Skills Required', 'multiselect', masterKey='skills', placeholder='Select or type skills'),
        _field('education', 'Education', 'select', masterKey='education_levels', placeholder='Select Education', width='half'),
        _field('openings', 'Openings', 'number', defaultValue=1, core=True, width='half'),
        _field('certifications', 'Certifications (Optional)', 'text', placeholder='e.g. AWS Certified'),
        _field('notes', 'Additional Notes', 'textarea', placeholder='Anything else candidates should know…'),
    ]},
    {'id': 'sec_meta', 'title': 'Posting Settings', 'collapsed': True, 'fields': [
        _field('priority', 'Priority', 'select', masterKey='priorities', defaultValue='Normal', core=True, width='half'),
        _field('status', 'Status', 'select', masterKey='statuses', defaultValue='Active', core=True, width='half'),
        _field('remote', 'Remote', 'boolean', defaultValue=False, core=True, width='half'),
    ]},
]


def _norm_options(raw):
    """Accept ['A','B'] or [{'value','label'}] and normalise to option dicts."""
    out = []
    for o in (raw or []):
        if isinstance(o, dict):
            v = str(o.get('value', o.get('label', ''))).strip()
            l = str(o.get('label', v)).strip()
            if v:
                out.append({'value': v, 'label': l or v})
        else:
            s = str(o).strip()
            if s:
                out.append({'value': s, 'label': s})
    return out


def _ensure_master():
    if MasterDataSet.objects.exists():
        return
    for m in DEFAULT_MASTER_DATA:
        MasterDataSet.objects.create(
            key=m['key'], label=m['label'],
            options=[{'value': o, 'label': o} for o in m['options']],
        )


def _active_template():
    t = JobFormTemplate.objects.filter(is_active=True).first()
    if t:
        return t
    t = JobFormTemplate.objects.filter(name='Default').first()
    if t:
        t.is_active = True
        t.save()
        return t
    return JobFormTemplate.objects.create(name='Default', is_active=True, schema=DEFAULT_SECTIONS)


# ── config (active schema) ─────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def job_form_config(request):
    _ensure_master()
    if request.method == 'GET':
        t = _active_template()
        return Response({'templateId': t.id, 'name': t.name, 'schema': t.schema or []})
    schema = request.data.get('schema')
    if not isinstance(schema, list):
        return _err('schema (a list of fields) is required')
    t = _active_template()
    name = (request.data.get('name') or '').strip()
    if name and name != t.name and not JobFormTemplate.objects.filter(name=name).exists():
        t.name = name
    t.schema = schema
    t.save()
    return Response({'templateId': t.id, 'name': t.name, 'schema': t.schema})


# ── templates ──────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def job_form_templates(request):
    if request.method == 'GET':
        return Response([{
            'id': x.id, 'name': x.name, 'isActive': x.is_active,
            'fields': len(x.schema or []),
            'updatedAt': x.updated_at.strftime('%Y-%m-%d %H:%M') if x.updated_at else '',
        } for x in JobFormTemplate.objects.all()])
    name = (request.data.get('name') or '').strip()
    if not name:
        return _err('name is required')
    if JobFormTemplate.objects.filter(name=name).exists():
        return _err('A template with this name already exists', 409)
    schema = request.data.get('schema')
    t = JobFormTemplate.objects.create(
        name=name,
        schema=schema if isinstance(schema, list) else [],
        created_by=(request.data.get('email') or ''),
    )
    return Response({'id': t.id, 'name': t.name}, status=201)


@api_view(['GET', 'PUT', 'DELETE'])
@permission_classes([AllowAny])
def job_form_template_detail(request, pk):
    t = JobFormTemplate.objects.filter(pk=pk).first()
    if not t:
        return _err('Template not found', 404)
    if request.method == 'GET':
        return Response({'id': t.id, 'name': t.name, 'isActive': t.is_active, 'schema': t.schema or []})
    if request.method == 'DELETE':
        if t.is_active:
            return _err('Cannot delete the active form — activate another template first.', 409)
        t.delete()
        return Response({'ok': True})
    body = request.data
    if isinstance(body.get('schema'), list):
        t.schema = body['schema']
    name = (body.get('name') or '').strip()
    if name and name != t.name and not JobFormTemplate.objects.filter(name=name).exclude(pk=t.pk).exists():
        t.name = name
    if body.get('activate'):
        JobFormTemplate.objects.exclude(pk=t.pk).update(is_active=False)
        t.is_active = True
    t.save()
    return Response({'id': t.id, 'name': t.name, 'isActive': t.is_active, 'schema': t.schema})


# ── master data ────────────────────────────────────────────────────────────
@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def master_data(request):
    _ensure_master()
    if request.method == 'GET':
        return Response([{'key': m.key, 'label': m.label, 'options': m.options or []}
                         for m in MasterDataSet.objects.all()])
    key = (request.data.get('key') or '').strip().lower().replace(' ', '_')
    label = (request.data.get('label') or '').strip()
    if not key or not label:
        return _err('key and label are required')
    m, _ = MasterDataSet.objects.get_or_create(key=key, defaults={'label': label})
    m.label = label
    m.options = _norm_options(request.data.get('options'))
    m.save()
    return Response({'key': m.key, 'label': m.label, 'options': m.options})


@api_view(['PUT', 'DELETE'])
@permission_classes([AllowAny])
def master_data_detail(request, key):
    m = MasterDataSet.objects.filter(key=key).first()
    if not m:
        return _err('Master data set not found', 404)
    if request.method == 'DELETE':
        m.delete()
        return Response({'ok': True})
    label = (request.data.get('label') or '').strip()
    if label:
        m.label = label
    if 'options' in request.data:
        m.options = _norm_options(request.data.get('options'))
    m.save()
    return Response({'key': m.key, 'label': m.label, 'options': m.options})


# ── world currencies (ISO 4217) ────────────────────────────────────────────
WORLD_CURRENCIES = [
    {'code': 'AED', 'name': 'UAE Dirham', 'symbol': 'د.إ'},
    {'code': 'AFN', 'name': 'Afghan Afghani', 'symbol': '؋'},
    {'code': 'ALL', 'name': 'Albanian Lek', 'symbol': 'L'},
    {'code': 'AMD', 'name': 'Armenian Dram', 'symbol': '֏'},
    {'code': 'ANG', 'name': 'Netherlands Antillean Guilder', 'symbol': 'ƒ'},
    {'code': 'AOA', 'name': 'Angolan Kwanza', 'symbol': 'Kz'},
    {'code': 'ARS', 'name': 'Argentine Peso', 'symbol': '$'},
    {'code': 'AUD', 'name': 'Australian Dollar', 'symbol': 'A$'},
    {'code': 'AWG', 'name': 'Aruban Florin', 'symbol': 'ƒ'},
    {'code': 'AZN', 'name': 'Azerbaijani Manat', 'symbol': '₼'},
    {'code': 'BAM', 'name': 'Bosnia-Herzegovina Convertible Mark', 'symbol': 'KM'},
    {'code': 'BBD', 'name': 'Barbadian Dollar', 'symbol': '$'},
    {'code': 'BDT', 'name': 'Bangladeshi Taka', 'symbol': '৳'},
    {'code': 'BGN', 'name': 'Bulgarian Lev', 'symbol': 'лв'},
    {'code': 'BHD', 'name': 'Bahraini Dinar', 'symbol': '.د.ب'},
    {'code': 'BIF', 'name': 'Burundian Franc', 'symbol': 'FBu'},
    {'code': 'BMD', 'name': 'Bermudan Dollar', 'symbol': '$'},
    {'code': 'BND', 'name': 'Brunei Dollar', 'symbol': '$'},
    {'code': 'BOB', 'name': 'Bolivian Boliviano', 'symbol': 'Bs.'},
    {'code': 'BRL', 'name': 'Brazilian Real', 'symbol': 'R$'},
    {'code': 'BSD', 'name': 'Bahamian Dollar', 'symbol': '$'},
    {'code': 'BTN', 'name': 'Bhutanese Ngultrum', 'symbol': 'Nu.'},
    {'code': 'BWP', 'name': 'Botswanan Pula', 'symbol': 'P'},
    {'code': 'BYN', 'name': 'Belarusian Ruble', 'symbol': 'Br'},
    {'code': 'BZD', 'name': 'Belize Dollar', 'symbol': 'BZ$'},
    {'code': 'CAD', 'name': 'Canadian Dollar', 'symbol': 'C$'},
    {'code': 'CDF', 'name': 'Congolese Franc', 'symbol': 'FC'},
    {'code': 'CHF', 'name': 'Swiss Franc', 'symbol': 'CHF'},
    {'code': 'CLP', 'name': 'Chilean Peso', 'symbol': '$'},
    {'code': 'CNY', 'name': 'Chinese Yuan', 'symbol': '¥'},
    {'code': 'COP', 'name': 'Colombian Peso', 'symbol': '$'},
    {'code': 'CRC', 'name': 'Costa Rican Colón', 'symbol': '₡'},
    {'code': 'CUP', 'name': 'Cuban Peso', 'symbol': '$'},
    {'code': 'CVE', 'name': 'Cape Verdean Escudo', 'symbol': '$'},
    {'code': 'CZK', 'name': 'Czech Koruna', 'symbol': 'Kč'},
    {'code': 'DJF', 'name': 'Djiboutian Franc', 'symbol': 'Fdj'},
    {'code': 'DKK', 'name': 'Danish Krone', 'symbol': 'kr'},
    {'code': 'DOP', 'name': 'Dominican Peso', 'symbol': 'RD$'},
    {'code': 'DZD', 'name': 'Algerian Dinar', 'symbol': 'دج'},
    {'code': 'EGP', 'name': 'Egyptian Pound', 'symbol': '£'},
    {'code': 'ERN', 'name': 'Eritrean Nakfa', 'symbol': 'Nfk'},
    {'code': 'ETB', 'name': 'Ethiopian Birr', 'symbol': 'Br'},
    {'code': 'EUR', 'name': 'Euro', 'symbol': '€'},
    {'code': 'FJD', 'name': 'Fijian Dollar', 'symbol': '$'},
    {'code': 'FKP', 'name': 'Falkland Islands Pound', 'symbol': '£'},
    {'code': 'GBP', 'name': 'British Pound', 'symbol': '£'},
    {'code': 'GEL', 'name': 'Georgian Lari', 'symbol': '₾'},
    {'code': 'GHS', 'name': 'Ghanaian Cedi', 'symbol': '₵'},
    {'code': 'GIP', 'name': 'Gibraltar Pound', 'symbol': '£'},
    {'code': 'GMD', 'name': 'Gambian Dalasi', 'symbol': 'D'},
    {'code': 'GNF', 'name': 'Guinean Franc', 'symbol': 'FG'},
    {'code': 'GTQ', 'name': 'Guatemalan Quetzal', 'symbol': 'Q'},
    {'code': 'GYD', 'name': 'Guyanaese Dollar', 'symbol': '$'},
    {'code': 'HKD', 'name': 'Hong Kong Dollar', 'symbol': 'HK$'},
    {'code': 'HNL', 'name': 'Honduran Lempira', 'symbol': 'L'},
    {'code': 'HRK', 'name': 'Croatian Kuna', 'symbol': 'kn'},
    {'code': 'HTG', 'name': 'Haitian Gourde', 'symbol': 'G'},
    {'code': 'HUF', 'name': 'Hungarian Forint', 'symbol': 'Ft'},
    {'code': 'IDR', 'name': 'Indonesian Rupiah', 'symbol': 'Rp'},
    {'code': 'ILS', 'name': 'Israeli New Shekel', 'symbol': '₪'},
    {'code': 'INR', 'name': 'Indian Rupee', 'symbol': '₹'},
    {'code': 'IQD', 'name': 'Iraqi Dinar', 'symbol': 'ع.د'},
    {'code': 'IRR', 'name': 'Iranian Rial', 'symbol': '﷼'},
    {'code': 'ISK', 'name': 'Icelandic Króna', 'symbol': 'kr'},
    {'code': 'JMD', 'name': 'Jamaican Dollar', 'symbol': 'J$'},
    {'code': 'JOD', 'name': 'Jordanian Dinar', 'symbol': 'د.ا'},
    {'code': 'JPY', 'name': 'Japanese Yen', 'symbol': '¥'},
    {'code': 'KES', 'name': 'Kenyan Shilling', 'symbol': 'KSh'},
    {'code': 'KGS', 'name': 'Kyrgystani Som', 'symbol': 'с'},
    {'code': 'KHR', 'name': 'Cambodian Riel', 'symbol': '៛'},
    {'code': 'KMF', 'name': 'Comorian Franc', 'symbol': 'CF'},
    {'code': 'KRW', 'name': 'South Korean Won', 'symbol': '₩'},
    {'code': 'KWD', 'name': 'Kuwaiti Dinar', 'symbol': 'د.ك'},
    {'code': 'KYD', 'name': 'Cayman Islands Dollar', 'symbol': '$'},
    {'code': 'KZT', 'name': 'Kazakhstani Tenge', 'symbol': '₸'},
    {'code': 'LAK', 'name': 'Laotian Kip', 'symbol': '₭'},
    {'code': 'LBP', 'name': 'Lebanese Pound', 'symbol': 'ل.ل'},
    {'code': 'LKR', 'name': 'Sri Lankan Rupee', 'symbol': 'Rs'},
    {'code': 'LRD', 'name': 'Liberian Dollar', 'symbol': '$'},
    {'code': 'LSL', 'name': 'Lesotho Loti', 'symbol': 'L'},
    {'code': 'LYD', 'name': 'Libyan Dinar', 'symbol': 'ل.د'},
    {'code': 'MAD', 'name': 'Moroccan Dirham', 'symbol': 'د.م.'},
    {'code': 'MDL', 'name': 'Moldovan Leu', 'symbol': 'L'},
    {'code': 'MGA', 'name': 'Malagasy Ariary', 'symbol': 'Ar'},
    {'code': 'MKD', 'name': 'Macedonian Denar', 'symbol': 'ден'},
    {'code': 'MMK', 'name': 'Myanmar Kyat', 'symbol': 'K'},
    {'code': 'MNT', 'name': 'Mongolian Tugrik', 'symbol': '₮'},
    {'code': 'MOP', 'name': 'Macanese Pataca', 'symbol': 'MOP$'},
    {'code': 'MRU', 'name': 'Mauritanian Ouguiya', 'symbol': 'UM'},
    {'code': 'MUR', 'name': 'Mauritian Rupee', 'symbol': '₨'},
    {'code': 'MVR', 'name': 'Maldivian Rufiyaa', 'symbol': '.ރ'},
    {'code': 'MWK', 'name': 'Malawian Kwacha', 'symbol': 'MK'},
    {'code': 'MXN', 'name': 'Mexican Peso', 'symbol': '$'},
    {'code': 'MYR', 'name': 'Malaysian Ringgit', 'symbol': 'RM'},
    {'code': 'MZN', 'name': 'Mozambican Metical', 'symbol': 'MT'},
    {'code': 'NAD', 'name': 'Namibian Dollar', 'symbol': '$'},
    {'code': 'NGN', 'name': 'Nigerian Naira', 'symbol': '₦'},
    {'code': 'NIO', 'name': 'Nicaraguan Córdoba', 'symbol': 'C$'},
    {'code': 'NOK', 'name': 'Norwegian Krone', 'symbol': 'kr'},
    {'code': 'NPR', 'name': 'Nepalese Rupee', 'symbol': '₨'},
    {'code': 'NZD', 'name': 'New Zealand Dollar', 'symbol': 'NZ$'},
    {'code': 'OMR', 'name': 'Omani Rial', 'symbol': 'ر.ع.'},
    {'code': 'PAB', 'name': 'Panamanian Balboa', 'symbol': 'B/.'},
    {'code': 'PEN', 'name': 'Peruvian Sol', 'symbol': 'S/.'},
    {'code': 'PGK', 'name': 'Papua New Guinean Kina', 'symbol': 'K'},
    {'code': 'PHP', 'name': 'Philippine Peso', 'symbol': '₱'},
    {'code': 'PKR', 'name': 'Pakistani Rupee', 'symbol': '₨'},
    {'code': 'PLN', 'name': 'Polish Zloty', 'symbol': 'zł'},
    {'code': 'PYG', 'name': 'Paraguayan Guarani', 'symbol': '₲'},
    {'code': 'QAR', 'name': 'Qatari Rial', 'symbol': 'ر.ق'},
    {'code': 'RON', 'name': 'Romanian Leu', 'symbol': 'lei'},
    {'code': 'RSD', 'name': 'Serbian Dinar', 'symbol': 'дин.'},
    {'code': 'RUB', 'name': 'Russian Ruble', 'symbol': '₽'},
    {'code': 'RWF', 'name': 'Rwandan Franc', 'symbol': 'FRw'},
    {'code': 'SAR', 'name': 'Saudi Riyal', 'symbol': 'ر.س'},
    {'code': 'SBD', 'name': 'Solomon Islands Dollar', 'symbol': '$'},
    {'code': 'SCR', 'name': 'Seychellois Rupee', 'symbol': '₨'},
    {'code': 'SDG', 'name': 'Sudanese Pound', 'symbol': 'ج.س.'},
    {'code': 'SEK', 'name': 'Swedish Krona', 'symbol': 'kr'},
    {'code': 'SGD', 'name': 'Singapore Dollar', 'symbol': 'S$'},
    {'code': 'SHP', 'name': 'Saint Helena Pound', 'symbol': '£'},
    {'code': 'SLL', 'name': 'Sierra Leonean Leone', 'symbol': 'Le'},
    {'code': 'SOS', 'name': 'Somali Shilling', 'symbol': 'S'},
    {'code': 'SRD', 'name': 'Surinamese Dollar', 'symbol': '$'},
    {'code': 'SSP', 'name': 'South Sudanese Pound', 'symbol': '£'},
    {'code': 'STN', 'name': 'São Tomé and Príncipe Dobra', 'symbol': 'Db'},
    {'code': 'SYP', 'name': 'Syrian Pound', 'symbol': '£'},
    {'code': 'SZL', 'name': 'Swazi Lilangeni', 'symbol': 'L'},
    {'code': 'THB', 'name': 'Thai Baht', 'symbol': '฿'},
    {'code': 'TJS', 'name': 'Tajikistani Somoni', 'symbol': 'ЅМ'},
    {'code': 'TMT', 'name': 'Turkmenistani Manat', 'symbol': 'm'},
    {'code': 'TND', 'name': 'Tunisian Dinar', 'symbol': 'د.ت'},
    {'code': 'TOP', 'name': 'Tongan Paʻanga', 'symbol': 'T$'},
    {'code': 'TRY', 'name': 'Turkish Lira', 'symbol': '₺'},
    {'code': 'TTD', 'name': 'Trinidad and Tobago Dollar', 'symbol': 'TT$'},
    {'code': 'TWD', 'name': 'New Taiwan Dollar', 'symbol': 'NT$'},
    {'code': 'TZS', 'name': 'Tanzanian Shilling', 'symbol': 'TSh'},
    {'code': 'UAH', 'name': 'Ukrainian Hryvnia', 'symbol': '₴'},
    {'code': 'UGX', 'name': 'Ugandan Shilling', 'symbol': 'USh'},
    {'code': 'USD', 'name': 'US Dollar', 'symbol': '$'},
    {'code': 'UYU', 'name': 'Uruguayan Peso', 'symbol': '$U'},
    {'code': 'UZS', 'name': 'Uzbekistani Som', 'symbol': "so'm"},
    {'code': 'VES', 'name': 'Venezuelan Bolívar', 'symbol': 'Bs.'},
    {'code': 'VND', 'name': 'Vietnamese Dong', 'symbol': '₫'},
    {'code': 'VUV', 'name': 'Vanuatu Vatu', 'symbol': 'VT'},
    {'code': 'WST', 'name': 'Samoan Tala', 'symbol': 'WS$'},
    {'code': 'XAF', 'name': 'Central African CFA Franc', 'symbol': 'FCFA'},
    {'code': 'XCD', 'name': 'East Caribbean Dollar', 'symbol': '$'},
    {'code': 'XOF', 'name': 'West African CFA Franc', 'symbol': 'CFA'},
    {'code': 'XPF', 'name': 'CFP Franc', 'symbol': '₣'},
    {'code': 'YER', 'name': 'Yemeni Rial', 'symbol': '﷼'},
    {'code': 'ZAR', 'name': 'South African Rand', 'symbol': 'R'},
    {'code': 'ZMW', 'name': 'Zambian Kwacha', 'symbol': 'ZK'},
    {'code': 'ZWL', 'name': 'Zimbabwean Dollar', 'symbol': 'Z$'},
]


@api_view(['GET'])
@permission_classes([AllowAny])
def currencies(request):
    return Response(WORLD_CURRENCIES)
