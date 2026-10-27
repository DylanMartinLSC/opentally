// Counting session: categories, markers and undo history. Pure data, no DOM.

const PALETTE = ['#2f80ed', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#00a3a3', '#d6336c', '#7a8b00'];

export class CountSession {
  constructor() {
    this.nextId = 1;
    this.categories = [];
    this.markers = [];
    this._undo = [];
    this._redo = [];
    this.categories.push({ id: this._id(), name: 'Objects', color: PALETTE[0] });
  }

  _id() {
    return this.nextId++;
  }

  _snapshot() {
    return JSON.stringify({ categories: this.categories, markers: this.markers });
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    this.categories = s.categories;
    this.markers = s.markers;
  }

  /** Record state before a mutation. */
  _commit() {
    this._undo.push(this._snapshot());
    if (this._undo.length > 500) this._undo.shift();
    this._redo = [];
  }

  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    return true;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  category(id) {
    return this.categories.find((c) => c.id === id);
  }

  addCategory(name, color) {
    this._commit();
    const c = { id: this._id(), name, color: color ?? PALETTE[this.categories.length % PALETTE.length] };
    this.categories.push(c);
    return c.id;
  }

  renameCategory(id, name) {
    const c = this.category(id);
    if (!c || c.name === name) return;
    this._commit();
    c.name = name;
  }

  setCategoryColor(id, color) {
    const c = this.category(id);
    if (!c || c.color === color) return;
    this._commit();
    c.color = color;
  }

  /** The last category can't be deleted. */
  deleteCategory(id) {
    if (this.categories.length <= 1 || !this.category(id)) return false;
    this._commit();
    this.categories = this.categories.filter((c) => c.id !== id);
    this.markers = this.markers.filter((m) => m.categoryId !== id);
    return true;
  }

  addMarker(x, y, categoryId, source = 'manual') {
    this._commit();
    const m = { id: this._id(), x, y, categoryId, source };
    this.markers.push(m);
    return m;
  }

  /** Remove the marker closest to (x, y) within `radius`; returns it or null. */
  removeNearest(x, y, radius, categoryId = null) {
    let best = null, bestD = radius;
    for (const m of this.markers) {
      if (categoryId != null && m.categoryId !== categoryId) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= bestD) { best = m; bestD = d; }
    }
    if (!best) return null;
    this._commit();
    this.markers = this.markers.filter((m) => m !== best);
    return best;
  }

  /** Replace this category's auto-detected markers; manual edits are kept. */
  setAutoMarkers(objects, categoryId) {
    this._commit();
    this.markers = this.markers.filter((m) => !(m.categoryId === categoryId && m.source === 'auto'));
    for (const o of objects) {
      const m = { id: this._id(), x: o.x, y: o.y, categoryId, source: 'auto' };
      if (o.r != null) m.r = o.r;
      this.markers.push(m);
    }
  }

  clearCategory(categoryId) {
    if (!this.markers.some((m) => m.categoryId === categoryId)) return;
    this._commit();
    this.markers = this.markers.filter((m) => m.categoryId !== categoryId);
  }

  count(categoryId) {
    let n = 0;
    for (const m of this.markers) if (m.categoryId === categoryId) n++;
    return n;
  }

  total() {
    return this.markers.length;
  }

  toJSON() {
    return { version: 1, nextId: this.nextId, categories: this.categories, markers: this.markers };
  }

  static fromJSON(json) {
    if (!json || json.version !== 1) throw new Error('Unsupported project file');
    const s = new CountSession();
    s.categories = json.categories;
    s.markers = json.markers;
    s.nextId = json.nextId;
    return s;
  }
}
