import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const script = await readFile(new URL('../assets/js/home.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../assets/css/home.css', import.meta.url), 'utf8')

function fixture(matches = true, hasScene = true) {
  const listeners = new Map()
  const frames = new Map()
  const styles = new Map()
  const classes = new Set()
  const media = { matches, addEventListener: (_, callback) => { media.change = callback } }
  let reads = 0
  let nextFrame = 0
  let height = 720
  const scene = {
    get offsetHeight() { reads++; return height },
    style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) },
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
  }
  const window = {
    scrollY: 0,
    matchMedia: query => {
      assert.equal(query, '(min-width: 821px) and (prefers-reduced-motion: no-preference)')
      return media
    },
    addEventListener: (type, callback, options) => listeners.set(type, { callback, options }),
    removeEventListener: type => listeners.delete(type),
  }
  runInNewContext(script, {
    document: { querySelector: selector => {
      assert.equal(selector, '.home-scene')
      return hasScene ? scene : null
    } },
    window,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id),
  })
  return {
    window, media, listeners, frames, styles, classes,
    reads: () => reads,
    resize: value => { height = value; listeners.get('resize')?.callback() },
    scroll: value => { window.scrollY = value; listeners.get('scroll')?.callback() },
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()) },
    offset: () => styles.get('--home-parallax-offset'),
  }
}

test('homepage scroll uses one passive, frame-coalesced transform with no per-scroll layout reads', () => {
  const app = fixture()
  assert.equal(app.reads(), 1)
  assert.equal(app.listeners.get('scroll').options.passive, true)
  app.flush()
  assert.equal(app.offset(), '0px')
  app.scroll(40)
  app.scroll(80)
  app.scroll(100)
  assert.equal(app.frames.size, 1)
  assert.equal(app.offset(), '0px', 'Scroll handler must not write immediately')
  app.flush()
  assert.equal(app.offset(), '80px') // 100px document scroll - 80px compensation = 20px photo travel.
  assert.equal(app.reads(), 1)
  assert.equal(app.frames.size, 0, 'No continuous animation loop')
})

test('negative overscroll, offscreen clamping and resize retain bounded motion', () => {
  const app = fixture()
  app.scroll(-30)
  app.flush()
  assert.equal(app.offset(), '0px')
  app.scroll(900)
  app.flush()
  assert.equal(app.offset(), '576px')
  app.resize(500)
  app.flush()
  assert.equal(app.offset(), '400px')
  assert.equal(app.reads(), 2)
})

test('mobile or reduced-motion preference starts completely static', () => {
  const app = fixture(false)
  assert.equal(app.listeners.size, 0)
  assert.equal(app.frames.size, 0)
  assert.equal(app.reads(), 0)
  assert.equal(app.offset(), undefined)
  assert.equal(app.classes.has('is-parallax'), false)
})

test('live preference/breakpoint changes cancel pending frames and reset motion', () => {
  const app = fixture()
  app.scroll(150)
  app.media.matches = false
  app.media.change()
  assert.equal(app.frames.size, 0)
  assert.equal(app.listeners.size, 0)
  assert.equal(app.offset(), undefined)
  assert.equal(app.classes.has('is-parallax'), false)
  app.media.matches = true
  app.media.change()
  app.flush()
  assert.equal(app.offset(), '120px')
  assert.equal(app.classes.has('is-parallax'), true)
})

test('other pages do nothing; CSS also gates transforms on desktop and no-preference', () => {
  const app = fixture(true, false)
  assert.equal(app.listeners.size, 0)
  assert.equal(app.frames.size, 0)
  assert.match(css, /@media \(min-width: 821px\) and \(prefers-reduced-motion: no-preference\)\s*{\s*\.home-scene\.is-parallax::before/)
  assert.match(css, /transform: translate3d\(0, var\(--home-parallax-offset, 0px\), 0\)/)
})
