"""Routes of the payroll extensions, mounted under /api/ by api/urls.py.

Each workstream owns its own urls_* module; a module that does not exist yet
(or fails to import) is skipped so the rest keeps working.
"""
import importlib
import logging

logger = logging.getLogger(__name__)

urlpatterns = []
for _name in ('urls_tax', 'urls_bank', 'urls_us', 'urls_ess'):
    try:
        urlpatterns += importlib.import_module(f'api.payroll_ext.{_name}').urlpatterns
    except ModuleNotFoundError as exc:
        if exc.name != f'api.payroll_ext.{_name}':
            logger.exception('payroll_ext: could not load %s', _name)
    except Exception:
        # Never let one broken module take the whole API down.
        logger.exception('payroll_ext: could not load %s', _name)
