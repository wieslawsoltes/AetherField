"""Optional browser integration checks; runtime app has no Python dependencies.
Install Playwright separately: python -m pip install playwright
Then: python tests/browser.py --chromium /usr/bin/chromium
Use --url http://127.0.0.1:8080 to test the served ES-module application.
Default tests the self-contained document without making network requests.
"""
from __future__ import annotations
import argparse, json, pathlib, time, traceback
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--chromium', default='/usr/bin/chromium')
parser.add_argument('--url')
args = parser.parse_args()
report = {'tests': [], 'environment': {}, 'pageErrors': []}

def check(name, fn):
    start = time.perf_counter()
    try:
        metric = fn()
        report['tests'].append({'name': name, 'passed': True, 'seconds': time.perf_counter()-start, 'metric': metric})
        print('PASS', name, metric, flush=True)
    except Exception as ex:
        report['tests'].append({'name': name, 'passed': False, 'seconds': time.perf_counter()-start, 'error': str(ex)})
        print('FAIL', name, str(ex), flush=True)
        raise

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width':1512,'height':982}, device_scale_factor=1, accept_downloads=True)
    page.on('pageerror', lambda e: report['pageErrors'].append(str(e)))
    page.set_default_timeout(7000)
    def ready():
        page.wait_for_function('window.aetherfield && !aetherfield.busy', timeout=20000)
    def solved():
        page.wait_for_function('window.aetherfield && !aetherfield.busy && !!aetherfield.result',timeout=20000)
    def button(action):
        selector=f'button[data-action="{action}"]'
        if not page.locator(selector).count(): page.locator('[data-tab="home"]').click()
        page.locator(selector).first.click()
    def world(x,y):
        point=page.evaluate('p=>aetherfield.renderer.worldToScreen(...p)',[x,y])
        box=page.locator('#overlay-canvas').bounding_box()
        return (box['x']+point[0],box['y']+point[1])
    def click_world(x,y): page.mouse.click(*world(x,y))
    def drag_world(x,y,x1,y1):
        page.mouse.move(*world(x,y));page.mouse.down();page.mouse.move(*world(x1,y1),steps=8);page.mouse.up()
    def library(name):
        button('examples');page.locator(f'[data-example="{name}"]').click();solved()
    try:
        if args.url: page.goto(args.url, wait_until='load')
        else: page.set_content((ROOT/'AetherField-standalone.html').read_text(), wait_until='load')
        solved()
        report['environment']=page.evaluate('''() => ({userAgent:navigator.userAgent, secureContext:isSecureContext, webgpuExposed:!!navigator.gpu, renderBackend:aetherfield.renderer.backend, computeDispatches:aetherfield.gpuDispatches, mode:location.href})''')
        def initial():
            value=page.evaluate('''() => {const r=aetherfield.result.runs[0],f=r.frames.at(-1);return {nodes:r.mesh.stats.nodes,elements:r.mesh.stats.elements,Tmax_K:f.summary.temperature.max,power_W:f.summary.joulePower,residual:f.nonlinear.residual,plotSamples:document.querySelector('.convergence-wrap polyline').getAttribute('points').split(' ').length};}''')
            assert value['nodes']==1157 and value['elements']==2140
            assert 350.14<value['Tmax_K']<350.16 and 4.28<value['power_W']<4.29
            assert value['plotSamples']>10 and value['residual']<1e-7
            page.screenshot(path=str(ROOT/'docs/screenshot.png'))
            return value
        check('Startup computes two-way Joule heating and plots recorded residuals',initial)
        def fields():
            for field in ['potential','joule','heatFlux','electricField','quality','temperature']:
                page.locator('#field-select').select_option(field)
                assert page.evaluate('aetherfield.project.view.field')==field
            button('toggle-mesh');button('toggle-vectors');page.wait_for_timeout(70)
            assert page.evaluate('aetherfield.project.view.mesh && aetherfield.project.view.vectors')
            page.screenshot(path=str(ROOT/'docs/mesh-vectors.png'))
            button('toggle-mesh');button('toggle-vectors')
            return 'Six computed fields, contours, mesh and vector overlays'
        check('Interactive field and overlay selection', fields)
        def probes():
            page.keyboard.press('p');click_world(.025,.02)
            assert page.evaluate('aetherfield.project.probes.length')==2
            value=page.evaluate('aetherfield.result.runs[0].probes[1].samples[0].T')
            assert 293.15<value<351
            click_world(.035,.03)
            assert page.evaluate('aetherfield.project.probes.length')==2
            return {'temperature_K':value,'holeRejected':True}
        check('Barycentric probe placement rejects points inside holes',probes)
        def exports():
            page.locator('[data-tab="results"]').click()
            with page.expect_download() as wait: button('csv')
            download=wait.value
            text=pathlib.Path(download.path()).read_text()
            assert len(text.splitlines())==1158 and 'temperature_K' in text
            with page.expect_download() as wait: button('vtk')
            text=pathlib.Path(wait.value.path()).read_text()
            assert 'CELLS 2140 8560' in text and 'POINT_DATA 1157' in text
            with page.expect_download() as wait: button('save')
            text=pathlib.Path(wait.value.path()).read_text();p=json.loads(text)
            page.evaluate("() => {window.__roundTrip=new Promise(resolve=>window.addEventListener('aetherfield:complete',resolve,{once:true}));}")
            page.locator('#project-file').set_input_files({'name':'roundtrip.afield','mimeType':'application/json','buffer':text.encode()})
            page.evaluate('window.__roundTrip.then(()=>true)');solved()
            assert page.evaluate('aetherfield.project.id')==p['id']
            assert page.evaluate('aetherfield.project.probes.length')==2
            return 'Full nodal CSV, VTK, project download/upload, persistent identities'
        check('Real result downloads and project file round trip',exports)
        def boundaries():
            page.keyboard.press('b');click_world(.035,.039)
            assert page.evaluate('aetherfield.project.boundaries.length')==3
            page.locator('[data-path="boundaries.2.heat.type"]').select_option('convection')
            assert page.evaluate('aetherfield.result===null')
            button('solve');solved()
            maximum=page.evaluate('aetherfield.result.runs[0].frames.at(-1).summary.temperature.max')
            assert 293.15<maximum<350.14635
            return {'newTmax_K':maximum,'selector':page.evaluate('aetherfield.project.boundaries[2].selector')}
        check('Pick a hole boundary, impose convection, recompute',boundaries)
        def geometry():
            page.keyboard.press('r');drag_world(.015,.004,.025,.014)
            assert page.evaluate('aetherfield.project.shapes.length')==6
            assert page.evaluate('aetherfield.result===null && aetherfield.mesh===null')
            button('undo');assert page.evaluate('aetherfield.project.shapes.length')==5
            button('redo');assert page.evaluate('aetherfield.project.shapes.length')==6
            page.keyboard.press('s');drag_world(.02,.009,.023,.011)
            shape=page.evaluate('aetherfield.project.shapes.at(-1)')
            assert abs(float(shape['x'].split('[')[0])-.018)<1e-9
            page.keyboard.press('Delete');assert page.evaluate('aetherfield.project.shapes.length')==5
            button('mesh');ready();assert page.evaluate('!!aetherfield.mesh && !aetherfield.result')
            return 'Pointer construction, drag, delete, atomic undo/redo, actual remeshing'
        check('Geometry editing and solution invalidation',geometry)
        def thermal():
            library('heat')
            value=page.evaluate('aetherfield.result.runs[0].probes[0].samples[0].T')
            assert abs(value-333.15)<1e-5
            return {'midpoint_K':value}
        check('Thermal slab model library workflow',thermal)
        def capacitor():
            library('electrostatics')
            f=page.evaluate('''() => {const f=aetherfield.result.runs[0].frames[0];return {V:aetherfield.result.runs[0].probes[0].samples[0].V,energy_J:f.summary.electricEnergy,E_V_m:f.summary.maxElectricField};}''')
            assert abs(f['V']-5)<1e-5 and abs(f['E_V_m']-100)<1e-3
            return f
        check('Electrostatic model library workflow',capacitor)
        def transient():
            library('transient')
            assert page.evaluate('aetherfield.result.runs[0].frames.length')==21
            page.locator('#time-slider').evaluate("e=>{e.value=0;e.dispatchEvent(new Event('input',{bubbles:true}));}")
            first=page.evaluate('aetherfield.renderer.scene.frame.time');assert first==0
            button('play');page.wait_for_timeout(240);button('play')
            time_now=page.evaluate('aetherfield.renderer.scene.frame.time');assert time_now>0
            return {'frames':21,'playedTime_s':time_now}
        check('Implicit thermal transient, frame slider and playback',transient)
        def sweep():
            page.evaluate('''() => {const p=aetherfield.project;p.physics.mode='joule';p.study.type='stationary';p.mesh.size='5[mm]';p.study.backend='cpu';p.study.sweep={enabled:true,parameter:'Vapp',values:'1[V],2[V]'};aetherfield.loadProject(p);}''')
            solved()
            values=page.evaluate('aetherfield.result.runs.map(r=>r.frames[0].summary.joulePower)')
            assert len(values)==2 and abs(values[1]/values[0]-4)<1e-7
            page.locator('#run-select').select_option('1')
            assert page.evaluate('aetherfield.renderer.scene.mesh===aetherfield.result.runs[1].mesh')
            return {'power_W':values,'ratio':values[1]/values[0]}
        check('Parameter sweep and dataset switching',sweep)
        def benchmarks():
            page.evaluate('aetherfield.runBenchmarks()');ready()
            r=page.evaluate('({passed:aetherfield.benchmarks.passed,total:aetherfield.benchmarks.total})')
            assert r['passed']==r['total'] and r['total']>=16
            assert not report['pageErrors'],report['pageErrors']
            return r
        check('Analytical suite runs inside the actual browser worker',benchmarks)
    except Exception:
        page.screenshot(path=str(ROOT/'tests/browser-failure.png'))
        traceback.print_exc()
    finally:
        report['passed']=sum(t['passed'] for t in report['tests']);report['total']=len(report['tests'])
        (ROOT/'tests/browser-results.json').write_text(json.dumps(report,indent=2))
        browser.close()
if report['passed']!=report['total'] or report['pageErrors']:raise SystemExit(1)
