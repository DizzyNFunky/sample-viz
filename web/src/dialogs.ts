/**
 * In-page replacements for confirm()/prompt(). The native ones block the
 * page and are unavailable in sandboxed hosts (e.g. an embedded preview).
 */

function open(build: (form: HTMLFormElement) => HTMLElement | null): Promise<string | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "ask";
    const form = document.createElement("form");
    form.method = "dialog";
    dlg.append(form);
    const focus = build(form);
    document.body.append(dlg);
    dlg.addEventListener("close", () => {
      const v = dlg.returnValue;
      dlg.remove();
      resolve(v === "" || v === "cancel" ? null : v);
    });
    dlg.showModal();
    focus?.focus();
  });
}

function buttons(form: HTMLFormElement, okLabel: string, danger: boolean, okValue = "ok") {
  const row = document.createElement("div");
  row.className = "row";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const cancel = document.createElement("button");
  cancel.value = "cancel";
  cancel.textContent = "Cancel";
  cancel.formNoValidate = true;
  const ok = document.createElement("button");
  ok.value = okValue;
  ok.textContent = okLabel;
  ok.className = danger ? "primary danger-fill" : "primary";
  row.append(spacer, cancel, ok);
  form.append(row);
  return ok;
}

export async function askConfirm(message: string, okLabel = "OK", danger = false): Promise<boolean> {
  const v = await open((form) => {
    const p = document.createElement("p");
    p.textContent = message;
    form.append(p);
    return buttons(form, okLabel, danger);
  });
  return v === "ok";
}

export async function askText(message: string, initial = "", okLabel = "OK"): Promise<string | null> {
  let input!: HTMLInputElement;
  const v = await open((form) => {
    const l = document.createElement("label");
    l.textContent = message;
    input = document.createElement("input");
    input.type = "text";
    input.id = "ask-text";
    input.value = initial;
    input.required = true;
    l.append(input);
    form.append(l);
    const ok = buttons(form, okLabel, false);
    form.addEventListener("submit", (e) => {
      // record the text as the dialog's return value
      e.preventDefault();
      const cancelled = (e.submitter as HTMLButtonElement | null)?.value === "cancel";
      (form.parentElement as HTMLDialogElement).close(!cancelled && input.value.trim() ? "ok" : "cancel");
    });
    ok.type = "submit";
    return input;
  });
  return v === "ok" ? input.value.trim() || null : null;
}
