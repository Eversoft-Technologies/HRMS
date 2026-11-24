"""One call for "a closed day's times changed": keep everything derived from
the day in step with the policy engine.

    after_day_changed(att, actor='', source='edit')

  1. day status (present / late / half-day / absent) from the hours
     (day_status.reclassify_day — audited)
  2. overtime record + payable overtime (overtime.on_day_closed)
  3. that month's late / early-out penalties (penalties.evaluate_for_day)

Check-out and regularization approval call these steps themselves; this is
for the other paths that rewrite a day's hours — HR's attendance edit, the old
correction approval and the hours recalculation — so payroll never sees an
unclassified day or unapproved overtime. Never raises.
"""
import logging

logger = logging.getLogger(__name__)


def after_day_changed(att, actor='', source='edit', keep_status=False):
    """keep_status: HR set the status by hand in this edit — respect it and
    only refresh overtime and penalties."""
    if att is None:
        return
    try:
        from .day_status import is_closed, reclassify_day
        if not is_closed(att):
            return
        if not keep_status:
            att = reclassify_day(att.email, att.date, actor=actor or 'system', source=source,
                                 reason='Day status re-evaluated after the hours changed') or att
    except Exception:
        logger.exception('day status re-evaluation failed for %s %s', att.email, att.date)
    try:
        from .overtime import on_day_closed
        on_day_closed(att)
    except Exception:
        logger.exception('overtime re-evaluation failed for %s %s', att.email, att.date)
    try:
        from .penalties import evaluate_for_day
        evaluate_for_day(att.email, att.date)
    except Exception:
        logger.exception('penalty re-evaluation failed for %s %s', att.email, att.date)
