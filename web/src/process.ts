/** Process panel, generated from the op registry (ops.ts). */
import { Editor } from "./editor";
import { Op, ParamValue } from "./ops";
import { formatTime } from "./util";

export class ProcessPanel {
  private root = document.getElementById("process-list")!;
  private scope = document.getElementById("process-scope")!;
  private applyButtons: { op: Op; btn: HTMLButtonElement }[] = [];

  constructor(private ed: Editor, private report: (msg: string, err?: boolean) => void) {
    const groups = new Map<string, Op[]>();
    for (const op of ed.ops) groups.set(op.group, [...(groups.get(op.group) ?? []), op]);
    for (const [name, ops] of groups) {
      const g = document.createElement("div");
      g.className = "op-group";
      const h = document.createElement("h3");
      h.textContent = name;
      g.append(h);
      for (const op of ops) g.append(this.card(op));
      this.root.append(g);
    }
  }

  private card(op: Op): HTMLElement {
    const values: Record<string, ParamValue> = {};
    const hasBody = !!(op.params?.length || op.description);
    const el = document.createElement(hasBody ? "details" : "div");
    el.className = "op";
    const sum = document.createElement(hasBody ? "summary" : "div");
    sum.className = "op-head";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = op.label;
    const btn = document.createElement("button");
    btn.textContent = "Apply";
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        this.ed.runOp(op, { ...values });
        this.report(op.label);
      } catch (err) {
        this.report((err as Error).message, true);
      }
    };
    this.applyButtons.push({ op, btn });
    sum.append(label, btn);
    el.append(sum);

    if (hasBody) {
      const body = document.createElement("div");
      body.className = "body";
      if (op.description) {
        const p = document.createElement("p");
        p.className = "desc";
        p.textContent = op.description;
        body.append(p);
      }
      for (const spec of op.params ?? []) {
        values[spec.id] = spec.default;
        const l = document.createElement("label");
        l.textContent = spec.label + ("unit" in spec && spec.unit ? ` (${spec.unit})` : "");
        let input: HTMLInputElement | HTMLSelectElement;
        if (spec.kind === "number") {
          const i = document.createElement("input");
          i.type = "number";
          i.min = String(spec.min);
          i.max = String(spec.max);
          i.step = String(spec.step);
          i.value = String(spec.default);
          i.onchange = () => {
            const v = Math.min(spec.max, Math.max(spec.min, Number(i.value)));
            values[spec.id] = Number.isFinite(v) ? v : spec.default;
            i.value = String(values[spec.id]);
          };
          input = i;
        } else if (spec.kind === "bool") {
          const i = document.createElement("input");
          i.type = "checkbox";
          i.checked = spec.default;
          i.onchange = () => (values[spec.id] = i.checked);
          input = i;
        } else {
          const s = document.createElement("select");
          for (const o of spec.options) s.add(new Option(o.label, o.value, false, o.value === spec.default));
          s.onchange = () => (values[spec.id] = s.value);
          input = s;
        }
        l.append(input);
        body.append(l);
      }
      el.append(body);
    }
    return el;
  }

  update() {
    const ed = this.ed;
    const sel = ed.selection;
    if (!ed.doc) this.scope.textContent = "Open a file to process it.";
    else if (sel) this.scope.textContent = `Applies to selection (${formatTime((sel.end - sel.start) / ed.sampleRate)})`;
    else this.scope.textContent = "Applies to the whole file";
    for (const { op, btn } of this.applyButtons) {
      btn.disabled = !ed.doc || (!!op.requiresSelection && !sel);
      btn.title = op.requiresSelection && !sel ? "Needs a selection" : "";
    }
  }
}
