"""Goals & OKRs (hrms_plus/okr.py, okr_views.py, management commands)."""
import io
from datetime import timedelta
from unittest import mock

from django.core.management import call_command
from django.test import Client, TestCase

from api.models import (AppUser, EmployeeTask, Notification, Permission, Role, RolePermission, Team,
                        TeamMembership, UserProfile)
from api.timeutil import local_now
from hrms_plus import okr
from hrms_plus.models import KeyResult, Objective, OkrCheckIn


def grant(role, *codes):
    for code in codes:
        perm, _ = Permission.objects.get_or_create(code=code, defaults={'name': code})
        RolePermission.objects.get_or_create(role=role, permission=perm)


class ProgressMathTests(TestCase):
    def kr(self, metric='number', start=0, target=100, current=0):
        return KeyResult(metric=metric, start_value=start, target_value=target, current_value=current)

    def test_increasing_and_clamped(self):
        self.assertEqual(okr.kr_progress(self.kr(start=10, target=60, current=35)), 50.0)
        self.assertEqual(okr.kr_progress(self.kr(start=0, target=100, current=150)), 100.0)
        self.assertEqual(okr.kr_progress(self.kr(start=10, target=60, current=0)), 0.0)

    def test_decreasing_target(self):
        # cut churn from 8% to 3%: at 5% we are 60% of the way
        self.assertEqual(okr.kr_progress(self.kr('percent', start=8, target=3, current=5)), 60.0)
        self.assertEqual(okr.kr_progress(self.kr('currency', start=1000, target=0, current=1200)), 0.0)
        self.assertEqual(okr.kr_progress(self.kr('number', start=8, target=3, current=1)), 100.0)

    def test_boolean_flat_and_milestone_steps(self):
        self.assertEqual(okr.kr_progress(self.kr('boolean', 0, 1, 0)), 0.0)
        self.assertEqual(okr.kr_progress(self.kr('boolean', 0, 1, 1)), 100.0)
        self.assertEqual(okr.kr_progress(self.kr('number', 5, 5, 5)), 100.0)
        self.assertEqual(okr.kr_progress(self.kr('number', 5, 5, 4)), 0.0)
        self.assertEqual(okr.kr_progress(self.kr('milestone', 0, 4, 1)), 25.0)

    def test_weighted_average(self):
        self.assertEqual(okr.weighted_average([(100, 3), (0, 1)]), 75.0)
        self.assertEqual(okr.weighted_average([(100, 0), (50, 0)]), 75.0)     # all zero -> plain average
        self.assertIsNone(okr.weighted_average([]))

    def test_periods(self):
        self.assertEqual(okr.period_bounds('2026-Q4')[1].isoformat(), '2026-12-31')
        self.assertEqual(okr.period_bounds('2026-Q1')[1].isoformat(), '2026-03-31')
        self.assertEqual(okr.shift_period('2026-Q4', 1), '2027-Q1')
        self.assertEqual(okr.shift_period('2026-Q1', -1), '2025-Q4')
        self.assertFalse(okr.valid_period('2026-Q5'))


class OkrBase(TestCase):
    def setUp(self):
        okr._LAZY['week'] = okr.iso_week()          # keep the lazy reminder pass out of API tests
        AppUser.objects.create(email='admin@x.com', full_name='Admin', password='x', role='admin')
        hr_role = Role.objects.create(name='HR Manager')
        grant(hr_role, 'okr.manage', 'employee.view')
        emp = Role.objects.create(name='Employee')
        AppUser.objects.create(email='hr@x.com', full_name='Hana HR', password='x', role='hr', role_ref=hr_role)
        people = (('boss@x.com', 'Bo', 'Boss', '', 'Engineering'),
                  ('mgr@x.com', 'Mia', 'Manager', 'boss@x.com', 'Engineering'),
                  ('bob@x.com', 'Bob', 'Dev', 'mgr@x.com', 'Engineering'),
                  ('cara@x.com', 'Cara', 'Dev', 'mgr@x.com', 'Engineering'),
                  ('dan@x.com', 'Dan', 'Sales', '', 'Sales'))
        for email, first, last, mgr, dept in people:
            AppUser.objects.create(email=email, full_name=f'{first} {last}', password='x', role='employee', role_ref=emp)
            UserProfile.objects.create(email=email, first_name=first, last_name=last, manager_email=mgr, department=dept)
        self.team = Team.objects.create(name='Core', department='Engineering', lead_email='mgr@x.com')
        for e in ('bob@x.com', 'cara@x.com'):
            TeamMembership.objects.create(team=self.team, email=e)
        self.c = {e.split('@')[0]: Client(HTTP_X_USER_EMAIL=e) for e in
                  ('admin@x.com', 'hr@x.com', 'boss@x.com', 'mgr@x.com', 'bob@x.com', 'cara@x.com', 'dan@x.com')}
        self.period = okr.current_period()

    def post(self, who, url, data):
        return self.c[who].post(url, data=data, content_type='application/json')

    def patch(self, who, url, data):
        return self.c[who].patch(url, data=data, content_type='application/json')

    def create(self, who, expect=201, **data):
        data.setdefault('period', self.period)
        r = self.post(who, '/api/okr/objectives', data)
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def check_in(self, who, kr_id, value, confidence=7, note=''):
        return self.post(who, f'/api/okr/key-results/{kr_id}/check-ins',
                         {'value': value, 'confidence': confidence, 'note': note})


class PermissionTests(OkrBase):
    def test_company_and_department_need_okr_manage(self):
        self.create('bob', 403, title='Win the market', level='company')
        self.create('mgr', 403, title='Eng excellence', level='department', department='Engineering')
        self.create('hr', title='Win the market', level='company')
        d = self.create('hr', title='Eng excellence', level='department', department='Engineering')
        self.assertEqual(d['department'], 'Engineering')
        # no department given and the owner (admin, no profile) has none either
        self.create('admin', 400, title='No dept', level='department', department='')
        # given none, it falls back to the owner's department
        self.assertEqual(self.create('admin', title='Sales push', level='department',
                                     ownerEmail='dan@x.com')['department'], 'Sales')

    def test_team_objectives_lead_or_their_manager(self):
        self.create('bob', 403, title='Ship v2', level='team', teamId=self.team.id)
        self.create('mgr', title='Ship v2', level='team', teamId=self.team.id)
        self.create('boss', title='Ship v3', level='team', teamId=self.team.id)   # the lead's manager
        self.create('dan', 403, title='Ship v4', level='team', teamId=self.team.id)
        self.create('mgr', 400, title='No team', level='team')

    def test_individual_owner_and_manager(self):
        mine = self.create('bob', title='Learn Rust')
        self.assertEqual(mine['ownerEmail'], 'bob@x.com')
        self.create('bob', 403, title='For Cara', ownerEmail='cara@x.com')
        by_mgr = self.create('mgr', title='Mentor', ownerEmail='bob@x.com')
        self.assertTrue(by_mgr['canEdit'])
        self.assertEqual(self.patch('dan', f'/api/okr/objectives/{mine["id"]}', {'title': 'x'}).status_code, 403)
        self.assertEqual(self.patch('mgr', f'/api/okr/objectives/{mine["id"]}', {'title': 'Learn Go'}).status_code, 200)
        # a KR owner who is not the objective owner can check in but not edit structure
        kr = self.post('bob', f'/api/okr/objectives/{mine["id"]}/key-results',
                       {'title': 'Read book', 'metric': 'percent', 'ownerEmail': 'cara@x.com'}).json()
        self.assertEqual(self.check_in('cara', kr['id'], 40).status_code, 201)
        self.assertEqual(self.patch('cara', f'/api/okr/key-results/{kr["id"]}', {'title': 'y'}).status_code, 403)
        self.assertEqual(self.check_in('dan', kr['id'], 50).status_code, 403)
        # cannot move your objective to a level you cannot own
        self.assertEqual(self.patch('bob', f'/api/okr/objectives/{mine["id"]}', {'level': 'company'}).status_code, 403)

    def test_unauthenticated(self):
        self.assertEqual(Client().get('/api/okr/objectives').status_code, 401)


class VisibilityAndAlignmentTests(OkrBase):
    def test_private_and_team_visibility(self):
        priv = self.create('bob', title='Secret', visibility='private')
        team = self.create('bob', title='Team-only', visibility='team')
        ids = lambda who: {o['id'] for o in self.c[who].get(f'/api/okr/objectives?period={self.period}').json()['results']}
        self.assertEqual(ids('cara') & {priv['id'], team['id']}, {team['id']})     # teammate sees team, not private
        self.assertEqual(ids('mgr') & {priv['id'], team['id']}, {priv['id'], team['id']})
        self.assertEqual(ids('hr') & {priv['id'], team['id']}, {priv['id'], team['id']})
        self.assertEqual(ids('dan') & {priv['id'], team['id']}, set())
        self.assertEqual(self.c['cara'].get(f'/api/okr/objectives/{priv["id"]}').status_code, 404)
        self.assertEqual(self.c['dan'].get(f'/api/okr/objectives/{team["id"]}').status_code, 404)
        self.assertEqual(self.c['boss'].get(f'/api/okr/objectives/{team["id"]}').status_code, 200)   # up the chain

    def test_align_under_visible_higher_objective(self):
        comp = self.create('hr', title='Grow revenue', level='company')
        secret = self.create('bob', title='Secret', visibility='private')
        mine = self.create('dan', title='Close 10 deals', parentId=comp['id'])
        self.assertEqual(mine['parentId'], comp['id'])
        self.assertEqual(mine['breadcrumb'][0]['id'], comp['id'])
        self.create('dan', 400, title='Hidden parent', parentId=secret['id'])
        self.create('hr', 400, title='Upside down', level='department', department='Sales', parentId=mine['id'])
        opts = self.c['dan'].get(f'/api/okr/alignment-options?level=individual&period={self.period}').json()['results']
        self.assertIn(comp['id'], [o['id'] for o in opts])
        self.assertNotIn(secret['id'], [o['id'] for o in opts])
        other = self.create('hr', 400, title='Wrong period', level='department', department='Sales',
                            parentId=comp['id'], period=okr.shift_period(self.period, 1))
        self.assertIn('same period', other['message'])

    def test_tree_nests_and_filters(self):
        comp = self.create('hr', title='Grow', level='company')
        dept = self.create('hr', title='Eng', level='department', department='Engineering', parentId=comp['id'])
        ind = self.create('bob', title='Mine', parentId=dept['id'])
        tree = self.c['bob'].get(f'/api/okr/objectives?tree=1&period={self.period}').json()['tree']
        root = [n for n in tree if n['id'] == comp['id']][0]
        self.assertEqual(root['children'][0]['id'], dept['id'])
        self.assertEqual(root['children'][0]['children'][0]['id'], ind['id'])
        mine = self.c['bob'].get(f'/api/okr/objectives?scope=mine&period={self.period}').json()['results']
        self.assertEqual([o['id'] for o in mine], [ind['id']])
        team = self.c['mgr'].get(f'/api/okr/objectives?scope=myteam&period={self.period}').json()['results']
        self.assertEqual([o['id'] for o in team], [ind['id']])


class RollupTests(OkrBase):
    def test_weighted_rollup_three_levels_up(self):
        comp = self.create('hr', title='Grow', level='company')
        dept = self.create('hr', title='Eng', level='department', department='Engineering', parentId=comp['id'])
        team = self.create('mgr', title='Ship', level='team', teamId=self.team.id, parentId=dept['id'])
        ind = self.create('bob', title='Mine', parentId=team['id'], keyResults=[
            {'title': 'Big', 'metric': 'number', 'startValue': 0, 'targetValue': 10, 'weight': 3},
            {'title': 'Small', 'metric': 'boolean', 'weight': 1}])
        big, small = ind['keyResults']
        r = self.check_in('bob', big['id'], 10)
        self.assertEqual(r.status_code, 201, r.content)
        for o in (ind, team, dept, comp):
            self.assertEqual(Objective.objects.get(pk=o['id']).progress, 75.0)
        # a second department child averages in at the company level
        self.create('hr', title='Sales', level='department', department='Sales', parentId=comp['id'],
                    keyResults=[{'title': 'Deals', 'metric': 'number', 'targetValue': 4, 'currentValue': 1}])
        self.assertEqual(Objective.objects.get(pk=comp['id']).progress, 50.0)
        # status auto-completes at 100
        self.check_in('bob', small['id'], 1)
        o = Objective.objects.get(pk=ind['id'])
        self.assertEqual((o.progress, o.status), (100.0, 'completed'))
        # reopening at 100% sticks
        self.patch('bob', f'/api/okr/objectives/{ind["id"]}', {'status': 'active'})
        self.check_in('bob', small['id'], 1, note='still done')
        self.assertEqual(Objective.objects.get(pk=ind['id']).status, 'active')

    def test_realign_rolls_up_old_and_new_parent(self):
        a = self.create('hr', title='A', level='company')
        b = self.create('hr', title='B', level='company')
        ind = self.create('bob', title='Mine', parentId=a['id'],
                          keyResults=[{'title': 'k', 'metric': 'percent', 'currentValue': 40}])
        self.assertEqual(Objective.objects.get(pk=a['id']).progress, 40.0)
        self.patch('bob', f'/api/okr/objectives/{ind["id"]}', {'parentId': b['id']})
        self.assertEqual(Objective.objects.get(pk=a['id']).progress, 0.0)
        self.assertEqual(Objective.objects.get(pk=b['id']).progress, 40.0)


class CheckInTests(OkrBase):
    def test_one_check_in_per_kr_per_week(self):
        o = self.create('bob', title='Mine', keyResults=[{'title': 'k', 'metric': 'percent'}])
        kr = o['keyResults'][0]['id']
        r1 = self.check_in('bob', kr, 20, 6, 'first')
        r2 = self.check_in('bob', kr, 35, 4, 'second')
        self.assertEqual((r1.status_code, r2.status_code), (201, 200))
        self.assertFalse(r2.json()['created'])
        rows = okr.real_check_ins().filter(key_result_id=kr)
        self.assertEqual(rows.count(), 1)
        self.assertEqual((rows[0].value, rows[0].confidence, rows[0].note), (35.0, 4, 'second'))
        k = KeyResult.objects.get(pk=kr)
        self.assertEqual((k.progress, k.confidence), (35.0, 4))
        okr.record_check_in('bob@x.com', k, 10, 5, 'last week', when=local_now() - timedelta(days=7))
        self.assertEqual(okr.real_check_ins().filter(key_result_id=kr).count(), 2)
        self.assertEqual(self.check_in('bob', kr, 50, 11).status_code, 400)
        self.assertEqual(self.check_in('bob', kr, 'abc').status_code, 400)

    def test_due_list_and_reminders(self):
        o = self.create('bob', title='Mine', keyResults=[{'title': 'k1', 'metric': 'percent'},
                                                          {'title': 'k2', 'metric': 'percent', 'ownerEmail': 'cara@x.com'}])
        k1, k2 = [k['id'] for k in o['keyResults']]
        due = self.c['bob'].get('/api/okr/check-ins/due').json()
        self.assertEqual([k['id'] for k in due['due']], [k1])
        sent = okr.send_checkin_reminders()
        self.assertEqual(sorted(sent), ['bob@x.com', 'cara@x.com'])
        n = Notification.objects.get(recipient='bob@x.com', title=okr.REMINDER_TITLE)
        self.assertIn('k1', n.message)
        self.assertTrue(n.link.startswith('/hr/perform/check-ins'))
        self.assertEqual(okr.send_checkin_reminders(), [])                    # once per week
        self.check_in('bob', k1, 10)
        self.assertEqual(self.c['bob'].get('/api/okr/check-ins/due').json()['due'], [])
        call_command('okr_reminders', stdout=io.StringIO())
        self.assertEqual(Notification.objects.filter(title=okr.REMINDER_TITLE).count(), 2)


class DigestTests(OkrBase):
    def test_weekly_digest_content(self):
        o = self.create('bob', title='Reduce bugs', keyResults=[
            {'title': 'Open bugs 40 -> 10', 'metric': 'number', 'startValue': 40, 'targetValue': 10, 'currentValue': 40},
            {'title': 'Shaky one', 'metric': 'percent', 'confidence': 3}])
        bugs = KeyResult.objects.get(pk=o['keyResults'][0]['id'])
        Objective.objects.filter(pk=o['id']).update(created_at=local_now() - timedelta(days=20))
        KeyResult.objects.filter(objective_id=o['id']).update(created_at=local_now() - timedelta(days=20))
        okr.record_check_in('bob@x.com', bugs, 34, 7, when=local_now() - timedelta(days=9))   # 20%
        okr.record_check_in('bob@x.com', bugs, 25, 7)                                        # 50%
        d = okr.build_digest('mgr@x.com', self.period)
        row = [r for r in d['objectives'] if r['id'] == o['id']][0]
        self.assertEqual(row['progress'], 25.0)            # (50*1 + 0*1) / 2
        self.assertEqual(row['delta'], 15.0)               # a week ago: (20 + 0) / 2 = 10
        self.assertIn('Shaky one', [r['kr'] for r in d['atRisk']])
        self.assertIn('low confidence', [r for r in d['atRisk'] if r['kr'] == 'Shaky one'][0]['reason'])
        # boss sees it too (reporting tree); dan has nothing
        self.assertEqual(len(okr.build_digest('boss@x.com', self.period)['objectives']), 1)
        with mock.patch('api.mailer.send_email', return_value={'ok': True}) as send:
            rows = okr.send_weekly_digests(self.period)
        self.assertEqual(sorted(r['to'] for r in rows), ['boss@x.com', 'mgr@x.com'])
        to, subject = send.call_args_list[0][0][:2]
        html = send.call_args_list[0][1]['html']
        self.assertIn('Weekly OKR digest', subject)
        self.assertIn('Reduce bugs', html)
        self.assertIn('Shaky one', html)
        self.assertIn('+15', html)

    def test_behind_schedule_is_at_risk(self):
        kr = KeyResult(progress=5, confidence=8, due_date=None)
        start, end = okr.period_bounds(self.period)
        mid = start + (end - start) / 2
        self.assertIn('behind schedule', okr.risk_reason(kr, self.period, mid))
        self.assertEqual(okr.risk_reason(kr, self.period, start), '')

    def test_command_dry_run(self):
        self.create('bob', title='Mine', keyResults=[{'title': 'k', 'metric': 'percent'}])
        with mock.patch('api.mailer.send_email') as send:
            call_command('okr_weekly_digest', '--dry-run', stdout=io.StringIO())
        send.assert_not_called()


class CopyForwardTests(OkrBase):
    def test_copy_unfinished_to_next_quarter(self):
        comp = self.create('hr', title='Grow', level='company')
        dept = self.create('hr', title='Eng', level='department', department='Engineering', parentId=comp['id'],
                           keyResults=[{'title': 'half', 'metric': 'percent', 'currentValue': 50},
                                       {'title': 'done', 'metric': 'boolean', 'currentValue': 1}])
        done = self.create('hr', title='Finished', level='company',
                           keyResults=[{'title': 'x', 'metric': 'boolean', 'currentValue': 1}])
        self.assertEqual(done['status'], 'completed')
        r = self.post('hr', '/api/okr/copy-forward', {'period': self.period})
        self.assertEqual(r.status_code, 200, r.content)
        nxt = okr.shift_period(self.period, 1)
        self.assertEqual(r.json()['period'], nxt)
        copies = {o.title: o for o in Objective.objects.filter(period=nxt)}
        self.assertEqual(set(copies), {'Grow', 'Eng'})
        self.assertEqual(copies['Eng'].parent_id, copies['Grow'].id)
        self.assertEqual([k.title for k in copies['Eng'].key_results.all()], ['half'])
        self.assertEqual(copies['Eng'].progress, 50.0)
        again = self.post('hr', '/api/okr/copy-forward', {'period': self.period}).json()
        self.assertEqual(again['created'], [])
        self.assertEqual(Objective.objects.filter(period=nxt).count(), 2)

    def test_copy_only_what_you_can_edit(self):
        self.create('hr', title='Grow', level='company')
        self.create('bob', title='Mine')
        r = self.post('bob', '/api/okr/copy-forward', {'period': self.period}).json()
        self.assertEqual([o['title'] for o in r['created']], ['Mine'])


class MilestoneTaskTests(OkrBase):
    def test_milestone_follows_linked_tasks(self):
        t1 = EmployeeTask.objects.create(title='Design', assignee_email='bob@x.com', stage='todo')
        t2 = EmployeeTask.objects.create(title='Build', assignee_email='bob@x.com', stage='inprogress')
        foreign = EmployeeTask.objects.create(title='Other', assignee_email='dan@x.com', stage='done')
        o = self.create('bob', title='Launch', keyResults=[{'title': 'Sprint 1', 'metric': 'milestone', 'targetValue': 3}])
        kr = o['keyResults'][0]['id']
        avail = self.c['bob'].get(f'/api/okr/tasks?kr={kr}').json()['results']
        self.assertEqual({t['id'] for t in avail}, {t1.id, t2.id})
        self.assertEqual(self.c['bob'].put(f'/api/okr/key-results/{kr}/tasks', data={'taskIds': [t1.id, foreign.id]},
                                           content_type='application/json').status_code, 404)
        r = self.c['bob'].put(f'/api/okr/key-results/{kr}/tasks', data={'taskIds': [t1.id, t2.id]},
                              content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['keyResult']['progress'], 0.0)
        t1.stage = 'done'
        t1.save()                                           # the task board saving a task
        k = KeyResult.objects.get(pk=kr)
        self.assertEqual((k.progress, k.current_value, k.target_value), (50.0, 1.0, 2.0))
        self.assertEqual(Objective.objects.get(pk=o['id']).progress, 50.0)
        # links are not check-ins
        self.assertEqual(self.c['bob'].get(f'/api/okr/key-results/{kr}/check-ins').json()['results'], [])
        # a check-in on a linked milestone keeps the task-derived value
        self.assertEqual(self.check_in('bob', kr, None, 6).status_code, 201)
        self.assertEqual(KeyResult.objects.get(pk=kr).current_value, 1.0)
        # task changed behind the signal's back is caught on read
        EmployeeTask.objects.filter(pk=t2.pk).update(stage='done')
        d = self.c['bob'].get(f'/api/okr/objectives/{o["id"]}').json()
        self.assertEqual(d['progress'], 100.0)
        self.assertEqual(OkrCheckIn.objects.filter(week=okr.LINK_WEEK, key_result_id=kr).count(), 2)


class SummaryTests(OkrBase):
    def test_person_team_and_my_team(self):
        self.create('bob', title='Mine', keyResults=[{'title': 'k', 'metric': 'percent', 'confidence': 2}])
        s = self.c['mgr'].get('/api/okr/summary?email=bob@x.com').json()
        self.assertEqual((s['objectiveCount'], len(s['atRisk']), s['checkInsDue']), (1, 1, 1))
        self.assertEqual(self.c['cara'].get('/api/okr/summary?email=bob@x.com').status_code, 403)
        self.assertEqual(self.c['bob'].get('/api/okr/summary').json()['email'], 'bob@x.com')
        team = self.c['mgr'].get(f'/api/okr/summary?team={self.team.id}').json()
        self.assertEqual({m['email'] for m in team['members']}, {'bob@x.com', 'cara@x.com', 'mgr@x.com'})
        self.assertEqual(self.c['dan'].get(f'/api/okr/summary?team={self.team.id}').status_code, 403)
        mt = self.c['mgr'].get('/api/okr/my-team').json()
        self.assertEqual([m['email'] for m in mt['members']], ['bob@x.com', 'cara@x.com'])
        meta = self.c['mgr'].get('/api/okr/meta').json()
        self.assertTrue(meta['isManager'])
        self.assertEqual(meta['currentPeriod'], self.period)
        self.assertFalse(self.c['bob'].get('/api/okr/meta').json()['canManage'])
        self.assertTrue(self.c['hr'].get('/api/okr/meta').json()['canManage'])
