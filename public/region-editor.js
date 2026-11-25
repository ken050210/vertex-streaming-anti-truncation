const labels = {
  global: "全球", us: "美国多区域", eu: "欧盟多区域", "asia-southeast1": "新加坡", "asia-northeast1": "东京",
  "australia-southeast1": "悉尼", "europe-west2": "伦敦", "us-central1": "爱荷华", "us-east1": "南卡罗来纳",
  "us-east4": "北弗吉尼亚", "us-east5": "哥伦布", "us-west1": "俄勒冈", "us-west4": "拉斯维加斯", "us-south1": "达拉斯",
  "northamerica-northeast1": "蒙特利尔", "southamerica-east1": "圣保罗", "europe-west1": "比利时", "europe-west3": "法兰克福",
  "europe-west4": "荷兰", "europe-west6": "苏黎世", "europe-west8": "米兰", "europe-west9": "巴黎",
  "europe-north1": "芬兰", "europe-central2": "华沙", "europe-southwest1": "马德里", "asia-south1": "孟买",
  "asia-east1": "台湾", "asia-east2": "香港", "asia-northeast3": "首尔", "me-west1": "特拉维夫", "me-central1": "多哈", "me-central2": "达曼",
};
export function addRegionSuggestions(list) {
  if (!list) return;
  const existing = new Set([...list.options].map(option => option.value));
  for (const [region, label] of Object.entries(labels)) {
    if (!existing.has(region)) list.append(new Option(label, region));
  }
}

// Shared by the gateway's connection cards and Tavern's Vertex drawer. Persistence belongs to the host.
export function createRegionEditor(root, { limit, help, buttonClass, onChange }) {
  root.innerHTML = `<details class="region-editor"><summary>429 区域切换 <span class="region-summary"></span></summary>
    <div class="region-fields"><label class="checkbox_label"><input type="checkbox"> 遇到 429 时尝试备用区域</label>
    <small class="region-help"></small><div class="region-order"><strong>备用区域顺序</strong>
    <ol></ol><div class="region-add"><select aria-label="选择备用区域"></select><button type="button">添加区域</button></div>
    <small class="region-preview" aria-live="polite"></small></div></div></details>`;
  const find = selector => root.querySelector(selector);
  const toggle = find("input"), chooser = find("select"), add = find("button"), list = find("ol");
  add.className = buttonClass;
  let locations = [], primary = "", allowed, disabledReason = "";
  function render() {
    toggle.disabled = Boolean(disabledReason);
    const enabled = toggle.checked && !toggle.disabled;
    const eligible = locations.filter(r => r !== primary && (!allowed || allowed.includes(r)));
    find(".region-summary").textContent = disabledReason ? "当前不可用" : enabled ? eligible.length + " 个备用区域" : "关闭";
    find(".region-help").textContent = disabledReason || help;
    find(".region-order").hidden = !enabled;
    const unsupported = allowed && !allowed.includes(primary);
    find(".region-preview").textContent = unsupported ? "此模型的首选区域可选 " + allowed.join("、")
      : "请求顺序 · " + [primary || "待选", ...eligible].join(" → ");
    list.replaceChildren();
    locations.forEach((region, i) => {
      const row = document.createElement("li");
      row.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = region + (region === primary ? "（与首选相同，跳过）" : allowed && !allowed.includes(region) ? "（此模型跳过）" : "");
      const up = document.createElement("button"), remove = document.createElement("button");
      up.type = remove.type = "button"; up.className = remove.className = buttonClass;
      up.textContent = "↑"; up.setAttribute("aria-label", "上移 " + region); up.disabled = i === 0;
      remove.textContent = "移除"; remove.setAttribute("aria-label", "移除 " + region);
      up.onclick = () => { [locations[i - 1], locations[i]] = [region, locations[i - 1]]; commit(); list.children[i - 1].focus(); };
      remove.onclick = () => { locations.splice(i, 1); commit(); chooser.focus(); };
      row.append(label, up, remove); list.append(row);
    });
    chooser.replaceChildren(new Option("选择备用区域…", ""));
    for (const region of allowed ?? Object.keys(labels)) {
      if (region !== primary && !locations.includes(region)) chooser.add(new Option((labels[region] || region) + " · " + region, region));
    }
    chooser.disabled = locations.length >= limit || chooser.length < 2;
    add.disabled = true;
  }
  function commit() { render(); onChange(); }
  toggle.onchange = commit;
  chooser.onchange = () => { add.disabled = !chooser.value; };
  add.onclick = () => { locations.push(chooser.value); commit(); };
  render();
  return {
    get value() { return { regionFallbackEnabled: toggle.checked, fallbackLocations: [...locations] }; },
    setValue(settings) {
      toggle.checked = settings.regionFallbackEnabled === true;
      locations = [...(settings.fallbackLocations ?? [])]; render();
    },
    setContext(region, supported, reason = "") {
      if (primary === region && allowed === supported && disabledReason === reason) return;
      primary = region; allowed = supported; disabledReason = reason; render();
    },
  };
}
