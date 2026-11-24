"""Routes of hrms_plus, mounted under /api/ (hrms_project/urls.py).

Each module owns its own urls_* file; a module that is missing or fails to
import is skipped so the rest of the API keeps working."""
import importlib
import logging

logger = logging.getLogger(__name__)

urlpatterns = []
for _name in ('urls_careers', 'urls_org', 'urls_okr', 'urls_assets'):
    try:
        urlpatterns += importlib.import_module(f'hrms_plus.{_name}').urlpatterns
    except ModuleNotFoundError as exc:
        if exc.name != f'hrms_plus.{_name}':
            logger.exception('hrms_plus: could not load %s', _name)
    except Exception:
        logger.exception('hrms_plus: could not load %s', _name)
