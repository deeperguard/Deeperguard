// Minimal DOM stub for exercising preview painting logic under plain node.
function parseSelector(selector) {
  return String(selector || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const classes = [];
      const tag = part.replace(/\.([A-Za-z0-9_-]+)/g, (_, cls) => {
        classes.push(cls);
        return '';
      }).trim();
      return { tag: tag.toLowerCase(), classes };
    });
}

class ClassList {
  constructor(el) {
    this.el = el;
  }

  get list() {
    return String(this.el.className || '').split(/\s+/).filter(Boolean);
  }

  set list(next) {
    this.el.className = next.join(' ');
  }

  add(...names) {
    const next = this.list;
    names.forEach((name) => { if (!next.includes(name)) next.push(name); });
    this.list = next;
  }

  remove(...names) {
    this.list = this.list.filter((name) => !names.includes(name));
  }

  contains(name) {
    return this.list.includes(name);
  }

  toggle(name, on) {
    if (on) this.add(name);
    else this.remove(name);
  }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.classList = new ClassList(this);
    this.listeners = {};
    // Fake layout: absolute offset in content space, scrolled by ancestors.
    this.layoutTop = 0;
    this.layoutHeight = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._scrollTop = 0;
    if (this.tagName === 'CANVAS') {
      this.width = 0;
      this.height = 0;
      this.ops = [];
      this.getContext = () => ({
        save() {}, restore() {},
        clearRect: (...args) => this.ops.push(['clear', ...args]),
        fillRect: (...args) => this.ops.push(['fill', ...args]),
        strokeRect: (...args) => this.ops.push(['stroke', ...args]),
        beginPath: () => this.ops.push(['beginPath']),
        moveTo: (...args) => this.ops.push(['moveTo', ...args]),
        lineTo: (...args) => this.ops.push(['lineTo', ...args]),
        stroke: () => this.ops.push(['stroke']),
        getImageData: (x, y, w, h) => ({ data: [], width: w, height: h }),
        putImageData: (...args) => this.ops.push(['put', args[1], args[2]]),
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
      });
    }
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get isConnected() {
    return true;
  }

  get parentElement() {
    return this.parentNode;
  }

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this._scrollTop = Math.min(max, Math.max(0, Number(value) || 0));
  }

  getBoundingClientRect() {
    let top = this.layoutTop;
    let node = this.parentNode;
    while (node) {
      top -= node.scrollTop || 0;
      node = node.parentNode;
    }
    return {
      top,
      bottom: top + this.layoutHeight,
      height: this.layoutHeight,
      left: 0,
      right: this.layoutWidth || 0,
      width: this.layoutWidth || 0,
    };
  }

  scrollIntoView() {
    /* nested scroll math is what we assert on; nothing to emulate here */
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...next) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    next.forEach((child) => this.appendChild(child));
  }

  replaceWith(next) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children[index] = next;
    next.parentNode = parent;
    this.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  matches(selector) {
    return parseSelector(selector).some((part) => {
      if (part.tag && part.tag !== this.tagName.toLowerCase()) return false;
      return part.classes.every((cls) => this.classList.contains(cls));
    });
  }

  descendants() {
    const out = [];
    this.children.forEach((child) => {
      out.push(child);
      out.push(...child.descendants());
    });
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (typeof node.matches === 'function' && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(fn);
  }

  removeEventListener() {}

  set innerHTML(value) {
    this._innerHTML = value;
    if (!value) this.replaceChildren();
  }

  get innerHTML() {
    return this._innerHTML || '';
  }
}

function install() {
  const document = {
    createElement: (tag) => new Element(tag),
  };
  const body = new Element('body');
  document.body = body;
  global.document = document;
  global.Element = Element;
  global.getComputedStyle = (el) => ({ overflowY: (el && el.style && el.style.overflowY) || 'visible' });
  global.innerHeight = 789;
  return { document, Element, body };
}

module.exports = { install, Element };
