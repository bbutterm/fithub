"""Local browser QA with explicitly synthetic API fixtures; no production data/auth bypass.
Run: python scripts/ui-smoke.py (pip install playwright; playwright install chromium).
Start Vite on 127.0.0.1:5178 first. Screenshots go to /tmp/fithub-ui-qa.
"""
import os
from pathlib import Path
from datetime import date
from playwright.sync_api import sync_playwright

BASE = os.environ.get('FITHUB_QA_URL', 'http://127.0.0.1:5178')
OUT = Path(os.environ.get('FITHUB_QA_OUT', '/tmp/fithub-ui-qa')); OUT.mkdir(exist_ok=True)
profile = dict(gender='male', birthYear=1995, heightCm=180, weightKg=80, activityLevel='moderate', goal='maintain', dietType='none', allergies=[], dislikes=[], medicalDiets=[], dietNotes=None, targetKcal=2100, targetProtein=140, targetFat=70, targetCarbs=230, adviceTone='friendly', adviceTime='18:00', adviceEnabled=True)
today = date.today().isoformat()
meal = dict(id=1, eatenAt=today+'T12:30:00', totalKcal=640, totalProtein=32, totalFat=21, totalCarbs=74, source='text', hasPhoto=False, photoToken=None, items=[dict(id=1,dish='Паста с курицей и овощами',grams=350,kcal=640,protein=32,fat=21,carbs=74)])
recipe = dict(id=1,name='Паста с курицей',kcal=640,protein=32,fat=21,carbs=74,portionGrams=350,timesUsed=3,items=[])
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    for width in [320,390,560]:
        page = browser.new_page(viewport=dict(width=width,height=844),reduced_motion='reduce')
        errors=[]; invoices=[]
        page.on('pageerror',lambda err:errors.append(str(err)))
        state={'day_error':False,'auth_profile':True,'hold_day':False,'held':[]}
        def route(req):
            url=req.request.url
            if '/invoice' in url: invoices.append(url)
            body={}
            if '/auth/telegram' in url: body=dict(token='fixture-only',user=dict(id=1,firstName='Ваня',tz='UTC'),hasProfile=state['auth_profile'],profile=profile,plan='free',isAdmin=False)
            elif '/day' in url:
                if state['hold_day']:
                    state['held'].append(req)
                    return
                if state['day_error']: return req.fulfill(status=503,json={'error':'fixture_failure'})
                body=dict(date=today,totals=dict(totalKcal=1240,totalProtein=82,totalFat=41,totalCarbs=126),meals=[meal])
            elif '/analytics' in url:
                if 'month' in url: return req.fulfill(status=402,json={'error':'pro_required'})
                body=dict(days=[dict(date=today,kcal=1240,protein=82,fat=41,carbs=126,mealsCount=2)],targets=dict(kcal=2100,protein=140,fat=70,carbs=230),averages=dict(kcal=1240,protein=82,fat=41,carbs=126),streak=3)
            elif '/recipes' in url: body=dict(recipes=[recipe])
            elif '/challenges' in url: body=dict(active=None,finished=[],templates=[dict(id='protein',title='Белок каждый день',days=7,ruleText='Следим за белком')])
            elif '/subscription' in url: body=dict(plan='free',usedToday=1,freeLimit=3,prices=dict(month=100,year=1000),expiresAt=None)
            elif '/diets' in url: body=dict(diets=[])
            elif '/meals/1' in url: body=dict(meal=meal)
            return req.fulfill(json=body)
        page.route('**/api/**',route)
        page.goto(BASE)
        page.get_by_role('heading',name='Баланс дня').wait_for()
        page.locator('.macro-rings svg').nth(2).wait_for()
        assert page.locator('.macro-rings svg').count()==3
        assert page.locator('.tabbar button').count()==5
        def shot(name):
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),name
            page.screenshot(path=str(OUT/f'{width}-{name}.png'),full_page=True)
        shot('today')
        page.locator('.swipe-content').first.click()
        page.get_by_role('dialog').wait_for()
        page.get_by_label('Порция: Паста с курицей и овощами, граммы').wait_for()
        shot('meal-dialog')
        page.keyboard.press('Escape')
        assert page.get_by_role('dialog').count()==0

        page.get_by_role('button',name='Предыдущий день').click()
        page.get_by_role('button',name='Вернуться к сегодня').wait_for()
        page.get_by_role('button',name='Вернуться к сегодня').click()
        # Hold a historical request, return to today, then deliver the old response.
        state['hold_day']=True
        page.get_by_role('button',name='Предыдущий день').click()
        page.wait_for_timeout(150)
        assert state['held'], 'Historical request was not captured'
        state['hold_day']=False
        page.get_by_role('button',name='Вернуться к сегодня').click()
        page.wait_for_timeout(150)
        for held in state['held']:
            held.fulfill(json=dict(date='2000-01-01',totals=dict(totalKcal=9999,totalProtein=999,totalFat=999,totalCarbs=999),meals=[]))
        page.wait_for_timeout(150)
        assert page.get_by_role('img',name='Калории, ккал: 1240 ккал из 2100 ккал',exact=True).count()==1
        for label,heading in [('Блюда','Мои блюда'),('Челлендж','Челленджи'),('Аналитика','Аналитика'),('Профиль','Профиль')]:
            page.locator('.tabbar').get_by_role('button',name=label).click()
            page.get_by_role('heading',name=heading,exact=True).first.wait_for()
            if label=='Блюда':
                page.get_by_role('button',name='Записать в дневник').click()
                page.get_by_role('button',name='Переименовать').click()
                page.get_by_label('Название блюда').fill('Новое название')
                page.get_by_role('button',name='Сохранить',exact=True).click()
            shot(label)
        page.get_by_role('button',name='Premium').click()
        page.get_by_role('heading',name='Пока без покупок').wait_for()
        assert not page.get_by_role('button',name='Stars').count()
        shot('premium')
        assert not invoices
        page.goto(BASE+'?screen=subscription')
        page.get_by_role('heading',name='Пока без покупок').wait_for()
        state['day_error']=True
        page.goto(BASE)
        page.get_by_role('alert').wait_for()
        shot('day-error')
        state['day_error']=False
        page.get_by_role('button',name='Повторить',exact=True).click()
        page.locator('.macro-rings svg').first.wait_for()
        page.evaluate("document.documentElement.dataset.theme='dark'; for(const [k,v] of Object.entries({'--tg-bg':'#18222d','--tg-secondary-bg':'#111922','--tg-card':'#202e3b','--tg-text':'#f3f5f7','--tg-hint':'#a7b4c2'})) document.documentElement.style.setProperty(k,v)")
        shot('dark')
        state['auth_profile']=False
        page.reload()
        page.get_by_role('heading',name='Настроим твоего нутрициолога').wait_for()
        shot('onboarding')
        assert not errors,errors
        print(f'PASS {width}px: rings/navigation/recipes/premium/deeplink/error-retry/dark/onboarding; no JS exceptions; no invoice requests')
        page.close()
    browser.close()
print('Screenshots:',OUT)
