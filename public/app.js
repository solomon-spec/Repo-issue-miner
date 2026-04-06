/* ================================================================== */
/*  Repo Issue Miner — Dashboard App                                   */
/* ================================================================== */

(function () {
  "use strict";

  /* ---- Helpers ---- */
  const $ = (s, ctx = document) => ctx.querySelector(s);
  const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function fmtDuration(ms) {
    if (!ms && ms !== 0) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function badgeClassForStatus(status) {
    return { running: "badge-running", completed: "badge-completed", failed: "badge-failed", stopped: "badge-warn", skipped: "badge-info" }[status] || "badge-warn";
  }

  function statusBadge(status) {
    return `<span class="badge ${badgeClassForStatus(status)}">${status}</span>`;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const text = await res.text();
    const looksLikeHtml = /^\s*</.test(text);

    const parseJson = () => {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        if (looksLikeHtml) {
          throw new Error(`The server returned HTML for ${path}. The backend may need a restart.`);
        }
        throw new Error(`The server returned an invalid JSON response for ${path}.`);
      }
    };

    if (!res.ok) {
      const err = parseJson();
      throw new Error(err.error || res.statusText);
    }
    return parseJson();
  }

  function shellQuote(value) {
    return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
  }

  function shellJoin(parts) {
    return (Array.isArray(parts) ? parts : []).map((part) => shellQuote(part)).join(" ");
  }

  function preferredSavedPlan(details) {
    return details?.rerun?.testPlan || details?.testPlan || details?.rerun?.execution?.usedPlan || details?.execution?.usedPlan || null;
  }

  function buildManualReproText({ repoFullName, repoUrl, prNumber, prUrl, preFixSha, details }) {
    if (!repoFullName || !preFixSha) return "";

    const repoName = repoFullName.split("/").pop() || "repo";
    const plan = preferredSavedPlan(details);
    const rerunOverride = details?.rerun?.dockerfileOverride;
    const lines = [
      `# Manual repro for ${repoFullName}`,
      `# Pre-fix snapshot: ${preFixSha}`,
    ];

    if (prNumber) {
      lines.push(`# PR: #${prNumber}${prUrl ? ` ${prUrl}` : ""}`);
    }

    lines.push(
      `git clone ${shellQuote(repoUrl || `https://github.com/${repoFullName}.git`)}`,
      `cd ${shellQuote(repoName)}`,
      `git checkout ${shellQuote(preFixSha)}`,
    );

    if (!plan) {
      lines.push("", "# No saved Docker build plan was available for this candidate.");
      return lines.join("\n");
    }

    if (plan.reasoningSummary) {
      lines.push("", `# Saved Docker build plan: ${plan.reasoningSummary}`);
    } else {
      lines.push("", `# Saved Docker build runner: ${plan.runner}`);
    }

    if (rerunOverride?.path) {
      lines.push(`# Last in-app rerun edited ${rerunOverride.path}; apply your local Dockerfile changes before building if you want to match that rerun.`);
    }

    if (plan.runner === "docker-run") {
      lines.push(
        `docker buildx build --progress=plain --load -t ${shellQuote("repo-issue-miner-manual")} -f ${shellQuote(plan.dockerfilePath || "Dockerfile")} .`,
      );
    } else if (plan.runner === "compose-run") {
      const composeFile = plan.composeFilePath || "docker-compose.yml";
      const composeServices = Array.isArray(plan.composeBuildServices) ? plan.composeBuildServices.filter(Boolean) : [];
      lines.push(
        `docker compose -f ${shellQuote(composeFile)} build${composeServices.length ? ` ${composeServices.map((service) => shellQuote(service)).join(" ")}` : ""}`,
      );
    } else if (plan.runner === "docker-target") {
      lines.push(
        `docker buildx build --progress=plain --load -t ${shellQuote("repo-issue-miner-manual")} -f ${shellQuote(plan.dockerfilePath || "Dockerfile")} .`,
      );
    } else {
      lines.push("# No runnable Docker command was inferred for this candidate.");
    }

    lines.push(
      Array.isArray(plan.testCommand) && plan.testCommand.length
        ? `# Suggested test plan if you want to run it yourself later: ${shellJoin(plan.testCommand)}`
        : "# Suggested test plan: none inferred",
    );

    return lines.join("\n");
  }

  function renderManualReproBlock(id, text) {
    if (!text) return "";
    return `
      <div class="manual-repro-block">
        <div class="manual-repro-header">
          <strong>Manual Repro</strong>
          <button type="button" class="btn btn-sm btn-info" data-copy-manual-repro="${esc(id)}">Copy</button>
        </div>
        <pre class="log-output log-output-compact manual-repro-output" data-manual-repro-text="${esc(id)}">${esc(text)}</pre>
      </div>
    `;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "absolute";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
  }

  function attachManualReproCopyHandlers(ctx = document) {
    $$("[data-copy-manual-repro]", ctx).forEach((button) => {
      if (button.dataset.bound === "true") return;
      button.dataset.bound = "true";
      button.addEventListener("click", async () => {
        const id = button.dataset.copyManualRepro;
        const output = $(`[data-manual-repro-text="${id}"]`, ctx);
        if (!output) return;

        const originalText = button.textContent;
        button.disabled = true;
        try {
          await copyTextToClipboard(output.textContent || "");
          button.textContent = "Copied";
        } catch (err) {
          alert("Failed to copy: " + err.message);
        } finally {
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 1200);
        }
      });
    });
  }

  /* ---- Navigation ---- */
  const pages = ["dashboard", "repos", "setup", "accepted", "accepted-detail", "tasks", "issues", "scans", "new-scan"];
  let currentPage = "dashboard";
  const selectedRepoIds = new Set();
  let visibleRepoIds = [];
  let taskWorkspaceCandidateId = null;
  let selectedSetupTarget = null;
  let setupProfilesCache = [];
  let selectedSetupRunId = null;
  let editingSetupProfileId = null;
  let setupProfileAutoSelectPending = true;
  let setupRunPoller = null;
  let setupRunPollInFlight = false;
  let setupRunTerminalState = {
    runId: null,
    scrollTop: 0,
    autoFollow: true,
  };
  let activeSetupRunDetail = null;
  let setupRunDetailState = {
    runId: null,
    tab: "overview",
  };

  function switchPage(page) {
    if (page !== "setup") {
      stopSetupRunPolling();
    }
    if (!["accepted", "accepted-detail"].includes(page)) {
      stopAcceptedTestRunPolling();
    }
    if (!["accepted", "accepted-detail", "tasks"].includes(page)) {
      stopAcceptedCodexReviewPolling();
    }
    currentPage = page;
    const activeNavPage = page === "accepted-detail" ? "accepted" : page;
    pages.forEach((p) => {
      const el = $(`#page-${p}`);
      const navTarget = p === "accepted-detail" ? "accepted" : p;
      const nav = $(`#nav-${navTarget.replace("-", "-")}`);
      if (!el) return;
      el.classList.toggle("active", p === page);
      if (nav) nav.classList.toggle("active", navTarget === activeNavPage);
    });
    $$(".nav-links a").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === activeNavPage);
    });
    loadPage(page);
  }

  $$(".nav-links a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      switchPage(a.dataset.page);
    });
  });

  function bindDashboardActions(ctx = document) {
    $$("[data-dashboard-action]", ctx).forEach((button) => {
      if (button.dataset.bound === "true") return;
      button.dataset.bound = "true";
      button.addEventListener("click", () => handleDashboardAction(button.dataset.dashboardAction));
    });
  }

  function handleDashboardAction(action) {
    switch (action) {
      case "repos":
      case "prs":
        switchPage("repos");
        break;
      case "new-scan":
        switchPage("new-scan");
        break;
      case "issues":
        switchPage("issues");
        break;
      case "accepted":
        switchPage("accepted");
        break;
      case "tasks":
        switchPage("tasks");
        break;
      case "rejected":
        switchPage("repos");
        break;
      case "scans":
        switchPage("scans");
        break;
      case "tests-unable":
        void openTestsUnableModal();
        break;
    }
  }

  function prepareSingleRepoDeepScan(fullName) {
    switchPage("new-scan");
    $("#f-target-repo").value = fullName;
    $("#f-scan-mode").value = "issue-first";
    $("#f-repo-limit").value = "1";
    $("#f-repo-concurrency").value = "1";
    $("#f-min-stars").value = "0";
    $("#f-pr-limit").value = "100";
    $("#f-merged-after").value = "";
  }

  function prepareRepoSetup(repo) {
    if (!repo?.id) return;
    setupProfileAutoSelectPending = true;
    selectedSetupTarget = {
      type: "repo",
      id: Number(repo.id),
      repoId: Number(repo.id),
      fullName: repo.fullName || repo.full_name || "Unknown Repo",
      stars: typeof repo.stars === "number" ? repo.stars : Number(repo.stars || 0),
      language: repo.primary_language || repo.primaryLanguage || "",
      description: repo.description || "",
      setupNote: "Setup runs against a fresh snapshot of the repository default branch and only prepares the codebase for later work.",
      label: repo.fullName || repo.full_name || "Unknown Repo",
    };
    selectedSetupRunId = null;
    switchPage("setup");
  }

  function prepareIssueSetup(issue) {
    if (!issue?.id) return;
    setupProfileAutoSelectPending = true;
    selectedSetupTarget = {
      type: "issue",
      id: Number(issue.id),
      repoId: Number(issue.repo_id),
      fullName: issue.repo_full_name || "Unknown Repo",
      stars: typeof issue.repo_stars === "number" ? issue.repo_stars : Number(issue.repo_stars || 0),
      language: issue.repo_primary_language || "",
      description: issue.repo_description || "",
      setupNote: "Setup runs against the linked fix PR base/pre-fix commit and does not implement the issue yet.",
      issueNumber: typeof issue.number === "number" ? issue.number : Number(issue.number || 0),
      issueTitle: issue.title || "",
      label: `${issue.repo_full_name} issue #${issue.number}${issue.title ? `: ${issue.title}` : ""}`,
    };
    selectedSetupRunId = null;
    switchPage("setup");
  }

  function prepareAcceptedSetup(row) {
    if (!row) return;
    const issues = Array.isArray(row.issues)
      ? row.issues.filter((issue) => Number.isFinite(Number(issue?.id)))
      : [];

    if (issues.length === 1) {
      const issue = issues[0];
      prepareIssueSetup({
        ...issue,
        repo_id: Number(row.repo_id),
        repo_full_name: row.repo_full_name || "",
        repo_stars: typeof row.repo_stars === "number" ? row.repo_stars : Number(row.repo_stars || 0),
        repo_primary_language: row.repo_primary_language || "",
        repo_description: row.repo_description || "",
      });
      return;
    }

    prepareRepoSetup({
      id: Number(row.repo_id),
      fullName: row.repo_full_name || "",
      stars: typeof row.repo_stars === "number" ? row.repo_stars : Number(row.repo_stars || 0),
      primary_language: row.repo_primary_language || "",
      description: row.repo_description || "",
    });
  }

  function openTaskWorkspace(candidateId) {
    taskWorkspaceCandidateId = candidateId ? String(candidateId) : null;
    switchPage("tasks");
  }

  function openAcceptedDetail(candidateId) {
    if (!candidateId) return;
    acceptedDetailCandidateId = String(candidateId);
    switchPage("accepted-detail");
  }

  function showAcceptedRepoFilter(repoId) {
    if (!repoId) return;
    acceptedRepoFilter = String(repoId);
    acceptedPage = 0;
    if ($("#accepted-repo-filter")) {
      $("#accepted-repo-filter").value = acceptedRepoFilter;
    }
    if (currentPage === "accepted") {
      void loadAccepted();
      return;
    }
    switchPage("accepted");
  }

  /* ---- Dashboard ---- */
  async function loadDashboard() {
    try {
      const stats = await api("/api/stats");
      const grid = $("#stats-grid");
      const statCards = [
        { action: "repos", accent: "accent-blue", label: "Repos", value: stats.repos },
        { action: "prs", accent: "accent-purple", label: "Pull Requests", value: stats.prs },
        { action: "issues", accent: "accent-cyan", label: "Issues", value: stats.issues },
        { action: "accepted", accent: "accent-green", label: "Accepted", value: stats.accepted },
        { action: "rejected", accent: "accent-red", label: "Rejected", value: stats.rejected },
        { action: "scans", accent: "accent-orange", label: "Scans", value: stats.scans },
        { action: "tests-unable", accent: "accent-warn", label: "⚠️ Tests Unable", value: stats.testsUnableToRun },
      ];

      grid.innerHTML = statCards.map((card) => `
        <button type="button" class="stat-card ${card.accent}" data-dashboard-action="${card.action}">
          <div class="stat-label">${card.label}</div>
          <div class="stat-value">${card.value}</div>
        </button>
      `).join("");

      bindDashboardActions($("#page-dashboard"));
      if (stats.lastScan) {
        const card = $("#last-scan-card");
        card.style.display = "block";
        $("#last-scan-info").innerHTML = `
          <dl class="detail-kv">
            <dt>Status</dt><dd>${statusBadge(stats.lastScan.status)}</dd>
            <dt>Started</dt><dd>${fmtDate(stats.lastScan.started_at)}</dd>
            <dt>Duration</dt><dd>${fmtDuration(stats.lastScan.total_duration_ms)}</dd>
            <dt>Accepted</dt><dd>${stats.lastScan.accepted_count}</dd>
            <dt>Rejected</dt><dd>${stats.lastScan.rejected_count}</dd>
          </dl>
        `;
      }
    } catch (err) {
      $("#stats-grid").innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${err.message}</p></div>`;
    }
  }

  /* ---- Repos ---- */
  let reposPage = 0;
  const REPOS_PER_PAGE = 20;
  let reposSortCol = '';
  let reposSortDir = 'desc';
  let reposLanguageFilter = '';
  let reposStatusFilter = '';

  function updateRepoBulkDeleteUI(rows = []) {
    const deleteBtn = $("#delete-selected-repos");
    const selectedCount = selectedRepoIds.size;
    deleteBtn.disabled = selectedCount === 0;
    deleteBtn.textContent = selectedCount > 0 ? `Delete Selected (${selectedCount})` : "Delete Selected";

    const selectAll = $("#select-all-repos");
    const rowIds = rows.map((row) => Number(row.id));
    const selectedVisible = rowIds.filter((id) => selectedRepoIds.has(id)).length;
    selectAll.checked = rowIds.length > 0 && selectedVisible === rowIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < rowIds.length;
  }

  function renderRepoPrProgress(repo) {
    const passed = Number(repo?.basic_filter_pass_count) || 0;
    const scanned = Number(repo?.scanned_pr_count) || 0;
    return `
      <div class="repo-pr-progress" title="Passed basic filter / scanned pull requests">
        <strong>${passed}/${scanned}</strong>
        <span>passed / scanned</span>
      </div>
    `;
  }

  async function loadRepos(search) {
    try {
      const params = new URLSearchParams({ limit: REPOS_PER_PAGE, offset: reposPage * REPOS_PER_PAGE });
      if (search) params.set("search", search);
      if (reposSortCol) params.set("sortBy", reposSortCol);
      if (reposSortDir) params.set("sortDir", reposSortDir);
      if (reposLanguageFilter) params.set("language", reposLanguageFilter);
      if (reposStatusFilter) params.set("status", reposStatusFilter);
      const data = await api(`/api/repos?${params}`);
      const tbody = $("#repos-tbody");
      visibleRepoIds = data.rows.map((row) => Number(row.id));

      // Populate the language filter dropdown dynamically
      const langSelect = $("#repo-language-filter");
      if (langSelect && Array.isArray(data.languages)) {
        const current = langSelect.value;
        langSelect.innerHTML = `<option value="">All Languages</option>` +
          data.languages.map((lang) => `<option value="${esc(lang)}" ${lang === current ? 'selected' : ''}>${esc(lang)}</option>`).join("");
      }

      // Update sortable header indicators
      $$(".sortable-header", $("#repos-table")).forEach((th) => {
        const col = th.dataset.sortCol;
        th.classList.remove("sort-asc", "sort-desc");
        if (col === reposSortCol) {
          th.classList.add(reposSortDir === "asc" ? "sort-asc" : "sort-desc");
        }
      });

      // Render table summary
      renderTableSummary("#repos-summary", data.total, REPOS_PER_PAGE, reposPage);

      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📦</div><p>No repos found matching your filters. ${search || reposLanguageFilter || reposStatusFilter ? '<a href="#" class="repo-link" id="clear-repo-filters">Clear all filters</a>' : 'Start a scan to mine repositories.'}</p></div></td></tr>`;
        $("#repos-pagination").innerHTML = "";
        updateRepoBulkDeleteUI([]);
        const clearLink = $("#clear-repo-filters");
        if (clearLink) {
          clearLink.addEventListener("click", (e) => {
            e.preventDefault();
            $("#repo-search").value = "";
            reposLanguageFilter = "";
            reposStatusFilter = "";
            if (langSelect) langSelect.value = "";
            $("#repo-status-filter").value = "";
            reposPage = 0;
            loadRepos();
          });
        }
        return;
      }

      tbody.innerHTML = data.rows.map((r) => `
        <tr>
          <td><input type="checkbox" data-repo-select="${r.id}" ${selectedRepoIds.has(Number(r.id)) ? "checked" : ""} aria-label="Select ${esc(r.full_name)}"></td>
          <td>
            <a href="https://github.com/${esc(r.full_name)}" target="_blank" class="repo-link-external" title="Open on GitHub">${esc(r.full_name)}</a>
            <a class="repo-link-internal" data-repo-id="${r.id}" title="View details"> ⓘ</a>
          </td>
          <td>⭐ ${r.stars}</td>
          <td>${esc(r.primary_language || "—")}</td>
          <td>${renderRepoPrProgress(r)}</td>
          <td>${r.issue_count}</td>
          <td>${r.accepted_count > 0 ? '<span class="badge badge-accepted">✅ Accepted</span>' : '<span class="badge badge-rejected">❌ Rejected</span>'}</td>
          <td>
            <button class="btn btn-sm" data-setup-repo="${r.id}" data-setup-repo-name="${esc(r.full_name)}">Setup</button>
            <button class="btn btn-sm btn-info" data-deep-scan-repo="${esc(r.full_name)}">Deep Scan</button>
            <button class="btn btn-sm btn-danger" data-delete-repo="${r.id}">Delete</button>
          </td>
        </tr>
      `).join("");

      renderPagination($("#repos-pagination"), data.total, REPOS_PER_PAGE, reposPage, (p) => { reposPage = p; loadRepos($("#repo-search").value); });

      // Repo detail
      $$("[data-repo-id]", tbody).forEach((a) => {
        a.addEventListener("click", () => openRepoDetail(Number(a.dataset.repoId)));
      });

      $$("[data-repo-select]", tbody).forEach((checkbox) => {
        checkbox.addEventListener("change", () => {
          const repoId = Number(checkbox.dataset.repoSelect);
          if (checkbox.checked) selectedRepoIds.add(repoId);
          else selectedRepoIds.delete(repoId);
          updateRepoBulkDeleteUI(data.rows);
        });
      });

      // Delete with toast
      $$("[data-delete-repo]", tbody).forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this repo from the database? It will be eligible for re-scanning.")) return;
          btn.disabled = true;
          btn.textContent = "Deleting…";
          try {
            selectedRepoIds.delete(Number(btn.dataset.deleteRepo));
            await api(`/api/repos/${btn.dataset.deleteRepo}`, { method: "DELETE" });
            showToast("Repo deleted successfully", "success");
            loadRepos($("#repo-search").value);
            loadDashboard();
          } catch (err) {
            showToast("Failed to delete repo: " + err.message, "error");
            btn.disabled = false;
            btn.textContent = "Delete";
          }
        });
      });

      $$("[data-deep-scan-repo]", tbody).forEach((btn) => {
        btn.addEventListener("click", () => {
          prepareSingleRepoDeepScan(btn.dataset.deepScanRepo);
        });
      });

      $$("[data-setup-repo]", tbody).forEach((btn) => {
        btn.addEventListener("click", () => {
          prepareRepoSetup({
            id: Number(btn.dataset.setupRepo),
            fullName: btn.dataset.setupRepoName,
          });
        });
      });

      updateRepoBulkDeleteUI(data.rows);
    } catch (err) {
      $("#repos-tbody").innerHTML = `<tr><td colspan="8"><div class="empty-state"><p>Error: ${err.message}</p></div></td></tr>`;
      updateRepoBulkDeleteUI([]);
    }
  }

  async function openRepoDetail(id) {
    const modal = $("#repo-detail-modal");
    const body = $("#repo-detail-body");
    body.innerHTML = "<p>Loading…</p>";
    modal.classList.remove("hidden");

    try {
      const data = await api(`/api/repos/${id}`);
      body.innerHTML = `
        <div style="display:flex; gap:0.75rem; align-items:center; justify-content:space-between; flex-wrap:wrap; margin-bottom:1rem;">
          <h2 style="margin:0;">${esc(data.full_name)}</h2>
          <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
            <button type="button" class="btn" data-modal-setup="${data.id}" data-modal-setup-name="${esc(data.full_name)}">Setup This Repo</button>
            <button type="button" class="btn btn-info" data-modal-deep-scan="${esc(data.full_name)}">Deep Scan This Repo</button>
          </div>
        </div>
        <div class="detail-section">
          <h4>Info</h4>
          <dl class="detail-kv">
            <dt>Stars</dt><dd>⭐ ${data.stars}</dd>
            <dt>Language</dt><dd>${esc(data.primary_language || "—")}</dd>
            <dt>Description</dt><dd>${esc(data.description || "—")}</dd>
            <dt>URL</dt><dd><a href="${data.url}" target="_blank" class="repo-link">${data.url}</a></dd>
            <dt>Added</dt><dd>${fmtDate(data.created_at)}</dd>
          </dl>
        </div>
        <div class="detail-section">
          <h4>Pull Requests (${data.pullRequests.length})</h4>
          ${data.pullRequests.length ? `<div class="table-wrap"><table>
            <thead><tr><th>#</th><th>Title</th><th>Merged</th><th>Issues</th></tr></thead>
            <tbody>${data.pullRequests.map((pr) => `
              <tr>
                <td><a href="${esc(pr.url)}" target="_blank" class="repo-link">#${pr.number}</a></td>
                <td>${esc(pr.title)}</td>
                <td>${fmtDate(pr.merged_at)}</td>
                <td>${pr.issue_count}</td>
              </tr>
            `).join("")}</tbody>
          </table></div>` : "<p>No pull requests.</p>"}
        </div>
        <div class="detail-section">
          <h4>Verified Issues (${data.issues.length})</h4>
          ${data.issues.length ? `<div class="table-wrap"><table>
            <thead><tr><th>#</th><th>Title</th><th>State</th><th>PR</th></tr></thead>
            <tbody>${data.issues.map((i) => `
              <tr>
                <td><a href="${esc(i.url || '#')}" target="_blank" class="repo-link">#${i.number}</a></td>
                <td>${esc(i.title || "—")}</td>
                <td><span class="badge ${i.state === 'open' ? 'badge-open' : 'badge-closed'}">${i.state || "—"}</span></td>
                <td>#${i.pr_number}</td>
              </tr>
            `).join("")}</tbody>
          </table></div>` : "<p>No issues.</p>"}
        </div>
        <div class="detail-section">
          <h4>Scan Candidates (${data.candidates.length})</h4>
          ${data.candidates.map((c) => {
            const timings = safeJSON(c.timings_json, []);
            const details = safeJSON(c.details_json, {});
            const manualRepro = buildManualReproText({
              repoFullName: data.full_name,
              repoUrl: data.url,
              preFixSha: c.pre_fix_sha,
              details,
            });
            return `
              <div style="margin-bottom:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:8px;">
                <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                  ${c.accepted ? '<span class="badge badge-accepted">Accepted</span>' : '<span class="badge badge-rejected">Rejected</span>'}
                  ${c.tests_unable_to_run ? '<span class="badge badge-warn">⚠️ Tests Unable</span>' : ''}
                  <span style="font-size:0.78rem; color:var(--text-muted);">SHA: ${esc(c.pre_fix_sha || "—").slice(0, 10)}</span>
                </div>
                ${c.tests_unable_to_run_reason ? `<p style="font-size:0.78rem; color:var(--accent-orange); margin-top:0.3rem;">${esc(c.tests_unable_to_run_reason)}</p>` : ''}
                ${c.rejection_reasons ? `<p style="font-size:0.78rem; color:var(--accent-red); margin-top:0.3rem;">${esc(safeJSON(c.rejection_reasons, []).join(", "))}</p>` : ''}
                ${timings.length ? renderTimings(timings) : ''}
                ${manualRepro ? renderManualReproBlock(`repo-candidate-${c.id}`, manualRepro) : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;
      const deepScanButton = $("[data-modal-deep-scan]", body);
      if (deepScanButton) {
        deepScanButton.addEventListener("click", () => {
          $("#repo-detail-modal").classList.add("hidden");
          prepareSingleRepoDeepScan(deepScanButton.dataset.modalDeepScan);
        });
      }
      const setupButton = $("[data-modal-setup]", body);
      if (setupButton) {
        setupButton.addEventListener("click", () => {
          $("#repo-detail-modal").classList.add("hidden");
          prepareRepoSetup({
            id: Number(setupButton.dataset.modalSetup),
            fullName: setupButton.dataset.modalSetupName,
            stars: data.stars,
            primary_language: data.primary_language,
            description: data.description,
          });
        });
      }
      attachManualReproCopyHandlers(body);
    } catch (err) {
      body.innerHTML = `<p>Error: ${err.message}</p>`;
    }
  }

  $("#modal-close").addEventListener("click", () => $("#repo-detail-modal").classList.add("hidden"));
  $("#repo-detail-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden"); });

  let repoSearchTimer;
  $("#repo-search").addEventListener("input", (e) => {
    clearTimeout(repoSearchTimer);
    repoSearchTimer = setTimeout(() => { reposPage = 0; loadRepos(e.target.value); }, 300);
  });

  // Sortable header click handlers
  $$(".sortable-header", $("#repos-table")).forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sortCol;
      if (reposSortCol === col) {
        reposSortDir = reposSortDir === "asc" ? "desc" : "asc";
      } else {
        reposSortCol = col;
        reposSortDir = col === "stars" || col === "issues" || col === "status" ? "desc" : "asc";
      }
      reposPage = 0;
      loadRepos($("#repo-search").value);
    });
  });

  // Language filter handler
  $("#repo-language-filter").addEventListener("change", (e) => {
    reposLanguageFilter = e.target.value;
    reposPage = 0;
    loadRepos($("#repo-search").value);
  });

  // Status filter handler
  $("#repo-status-filter").addEventListener("change", (e) => {
    reposStatusFilter = e.target.value;
    reposPage = 0;
    loadRepos($("#repo-search").value);
  });

  $("#select-all-repos").addEventListener("change", (e) => {
    visibleRepoIds.forEach((repoId) => {
      if (e.target.checked) selectedRepoIds.add(repoId);
      else selectedRepoIds.delete(repoId);
    });
    $$("[data-repo-select]", $("#repos-tbody")).forEach((checkbox) => {
      checkbox.checked = e.target.checked;
    });
    updateRepoBulkDeleteUI(visibleRepoIds.map((id) => ({ id })));
  });

  $("#delete-selected-repos").addEventListener("click", async () => {
    const ids = [...selectedRepoIds];
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} selected repo(s) from the database? They will be eligible for re-scanning.`)) return;

    const button = $("#delete-selected-repos");
    button.disabled = true;
    button.textContent = `Deleting ${ids.length}…`;
    try {
      for (const repoId of ids) {
        await api(`/api/repos/${repoId}`, { method: "DELETE" });
        selectedRepoIds.delete(repoId);
      }
      showToast(`${ids.length} repo(s) deleted successfully`, 'success');
      await loadRepos($("#repo-search").value);
      await loadDashboard();
    } catch (err) {
      showToast("Failed to delete selected repos: " + err.message, 'error');
      updateRepoBulkDeleteUI(visibleRepoIds.map((id) => ({ id })));
    }
  });

  /* ---- Setup ---- */
  function renderSetupSelectedRepo() {
    const container = $("#setup-selected-target");
    const startButton = $("#setup-start-button");
    if (!container || !startButton) return;

    if (!selectedSetupTarget) {
      container.innerHTML = `
        <strong>No target selected</strong>
        <span>Choose \`Setup\` from the repo list or the issues list to target a repository or a specific issue.</span>
      `;
      startButton.disabled = true;
      return;
    }

    const targetBadge = selectedSetupTarget.type === "issue"
      ? `Issue #${selectedSetupTarget.issueNumber || "?"}`
      : "Repository";
    const setupNote = selectedSetupTarget.setupNote
      || (selectedSetupTarget.type === "issue"
        ? "Setup runs against the linked fix PR base/pre-fix commit and does not implement the issue yet."
        : "Setup runs against a fresh snapshot of the repository default branch and only prepares the codebase for later work.");
    const repoDescription = typeof selectedSetupTarget.description === "string" && selectedSetupTarget.description.trim()
      ? `<span>${esc(selectedSetupTarget.description.trim())}</span>`
      : "";

    container.innerHTML = `
      <strong>${esc(selectedSetupTarget.label || selectedSetupTarget.fullName)}</strong>
      <span>${esc(targetBadge)} • ${selectedSetupTarget.language ? esc(selectedSetupTarget.language) : "Language unknown"}${selectedSetupTarget.stars ? ` • ⭐ ${selectedSetupTarget.stars}` : ""}</span>
      <span>${esc(setupNote)}</span>
      ${repoDescription}
    `;
    startButton.disabled = setupProfilesCache.length === 0;
  }

  function renderSetupProfileSelect() {
    const select = $("#setup-profile-select");
    if (!select) return;
    const currentValue = Number(select.value);

    if (!setupProfilesCache.length) {
      select.innerHTML = `<option value="">No profiles yet</option>`;
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML = setupProfilesCache.map((profile) => `
      <option value="${profile.id}">${esc(profile.name)}</option>
    `).join("");

    const normalizedLanguage = typeof selectedSetupTarget?.language === "string"
      ? selectedSetupTarget.language.trim().toLowerCase()
      : "";
    const recommendedName = normalizedLanguage.includes("typescript")
      ? "TypeScript Initial Setup"
      : (normalizedLanguage.includes("javascript")
        ? "JavaScript Initial Setup"
        : "Python Initial Setup");
    const recommendedProfile = setupProfilesCache.find((profile) => profile.name === recommendedName)
      || setupProfilesCache.find((profile) => profile.name === "Python Initial Setup")
      || setupProfilesCache[0];
    const nextValue = (!setupProfileAutoSelectPending && setupProfilesCache.some((profile) => profile.id === currentValue))
      ? currentValue
      : recommendedProfile.id;
    select.value = String(nextValue);
    setupProfileAutoSelectPending = false;
  }

  function populateSetupProfileForm(profile) {
    $("#setup-profile-id").value = profile?.id ? String(profile.id) : "";
    $("#setup-profile-name").value = profile?.name || "";
    $("#setup-profile-model").value = profile?.model || "";
    $("#setup-profile-clone-root").value = profile?.cloneRootPath || "";
    $("#setup-profile-sandbox").value = profile?.sandboxMode || "danger-full-access";
    $("#setup-profile-prompt").value = profile?.prompt || "";
    $("#setup-profile-context-paths").value = Array.isArray(profile?.contextPaths) ? profile.contextPaths.join("\n") : "";
    $("#setup-profile-writable-paths").value = Array.isArray(profile?.writablePaths) ? profile.writablePaths.join("\n") : "";
    $("#setup-profile-validation-prompt").value = profile?.validationPrompt || "";
    $("#setup-profile-editor-title").textContent = profile?.id ? `Edit Profile: ${profile.name}` : "New Profile";
    $("#setup-delete-profile").disabled = !profile?.id;
  }

  function renderSetupProfileList() {
    const container = $("#setup-profile-list");
    if (!container) return;

    if (!setupProfilesCache.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🧩</div><p>Create a setup profile to tell Codex which files to read, what it can edit, and how it should validate the setup.</p></div>`;
      return;
    }

    container.innerHTML = setupProfilesCache.map((profile) => `
      <button
        type="button"
        class="setup-profile-item ${editingSetupProfileId === profile.id ? "active" : ""}"
        data-setup-profile-edit="${profile.id}"
      >
        <strong>${esc(profile.name)}</strong>
        <span>${esc(profile.sandboxMode === "danger-full-access" ? "Danger full access" : "Workspace write")}</span>
        <small>${profile.contextPaths.length} context paths • ${profile.writablePaths.length} writable paths • ${profile.validationPrompt ? "validation prompt set" : "no validation prompt"} • ${esc(profile.cloneRootPath || "")}</small>
      </button>
    `).join("");

    $$("[data-setup-profile-edit]", container).forEach((button) => {
      button.addEventListener("click", () => {
        const profileId = Number(button.dataset.setupProfileEdit);
        const profile = setupProfilesCache.find((item) => item.id === profileId);
        if (!profile) return;
        editingSetupProfileId = profile.id;
        populateSetupProfileForm(profile);
        renderSetupProfileList();
      });
    });
  }

  function setupProfilePayloadFromForm() {
    return {
      name: $("#setup-profile-name").value.trim(),
      model: $("#setup-profile-model").value.trim(),
      cloneRootPath: $("#setup-profile-clone-root").value.trim(),
      sandboxMode: $("#setup-profile-sandbox").value,
      prompt: $("#setup-profile-prompt").value.trim(),
      contextPaths: $("#setup-profile-context-paths").value,
      writablePaths: $("#setup-profile-writable-paths").value,
      validationPrompt: $("#setup-profile-validation-prompt").value.trim(),
    };
  }

  async function loadSetupProfiles() {
    setupProfilesCache = await api("/api/setup/profiles");
    renderSetupProfileSelect();
    renderSetupSelectedRepo();
    if (editingSetupProfileId) {
      const existing = setupProfilesCache.find((profile) => profile.id === editingSetupProfileId);
      if (existing) {
        populateSetupProfileForm(existing);
      } else {
        editingSetupProfileId = null;
      }
    }
    if (!editingSetupProfileId) {
      const firstProfile = setupProfilesCache[0] || null;
      editingSetupProfileId = firstProfile?.id || null;
      populateSetupProfileForm(firstProfile);
    }
    renderSetupProfileList();
  }

  function renderSetupChipList(items, emptyLabel, modifier = "") {
    if (!Array.isArray(items) || !items.length) {
      return `<span class="setup-chip muted">${esc(emptyLabel)}</span>`;
    }
    return items.map((item) => `<span class="setup-chip ${modifier}">${esc(item)}</span>`).join("");
  }

  function parseSetupLogEntries(logs) {
    if (!Array.isArray(logs)) return [];
    return logs
      .map((line) => {
        const text = String(line || "");
        const match = text.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (!match) return null;
        return { raw: text, at: match[1], message: match[2] || "" };
      })
      .filter(Boolean);
  }

  function classifySetupEventTone(message, fallbackStatus = "") {
    const text = String(message || "").toLowerCase();
    if (/failed|error|out-of-scope/.test(text)) return "failed";
    if (/skip_setup|skipped|blocked/.test(text)) return "info";
    if (/stopped/.test(text)) return "warn";
    if (/completed|passed|created setup commit/.test(text)) return "completed";
    if (/running|preparing|configuring|removing|staging|creating/.test(text)) return "running";
    return fallbackStatus || "info";
  }

  function extractSetupCommands(entries) {
    const commands = [];
    let codexCommand = null;

    entries.forEach((entry) => {
      const message = entry.message || "";
      if (message.startsWith("Running command: ")) {
        commands.push({
          command: message.slice("Running command: ".length),
          status: "running",
          startedAt: entry.at,
          finishedAt: null,
          durationText: "",
          source: "shell",
        });
        return;
      }

      let match = message.match(/^Command passed after (.+?): (.+)$/);
      if (match) {
        const pending = [...commands].reverse().find((item) => item.command === match[2] && item.status === "running");
        if (pending) {
          pending.status = "completed";
          pending.finishedAt = entry.at;
          pending.durationText = match[1];
        } else {
          commands.push({
            command: match[2],
            status: "completed",
            startedAt: null,
            finishedAt: entry.at,
            durationText: match[1],
            source: "shell",
          });
        }
        return;
      }

      match = message.match(/^Command failed after (.+?): (.+?)(?: — .+)?$/);
      if (match) {
        const pending = [...commands].reverse().find((item) => item.command === match[2] && item.status === "running");
        if (pending) {
          pending.status = "failed";
          pending.finishedAt = entry.at;
          pending.durationText = match[1];
        } else {
          commands.push({
            command: match[2],
            status: "failed",
            startedAt: null,
            finishedAt: entry.at,
            durationText: match[1],
            source: "shell",
          });
        }
        return;
      }

      if (message.startsWith("Running Codex via ")) {
        codexCommand = {
          command: "codex exec",
          status: "running",
          startedAt: entry.at,
          finishedAt: null,
          durationText: "",
          source: "codex",
          detail: message.slice("Running Codex via ".length),
        };
        commands.push(codexCommand);
        return;
      }

      match = message.match(/^Codex exited with code (\S+) after (.+)$/);
      if (match && codexCommand) {
        codexCommand.status = match[1] === "0" ? "completed" : "failed";
        codexCommand.finishedAt = entry.at;
        codexCommand.durationText = match[2];
      }
    });

    return commands;
  }

  function buildSetupTimeline(run, entries) {
    const items = [{
      title: "Run started",
      detail: run.targetLabel || run.repoFullName,
      at: run.startedAt,
      tone: "running",
    }];

    const filtered = entries.filter((entry) => {
      const message = entry.message || "";
      return !/^Running command: /.test(message)
        && !/^Command passed after /.test(message)
        && !/^Command failed after /.test(message);
    });

    filtered.forEach((entry) => {
      items.push({
        title: entry.message,
        detail: "",
        at: entry.at,
        tone: classifySetupEventTone(entry.message),
      });
    });

    if (!filtered.length && run.stage) {
      items.push({
        title: run.stage,
        detail: "",
        at: run.finishedAt || run.startedAt,
        tone: classifySetupEventTone(run.stage, run.status),
      });
    }

    if (run.finishedAt) {
      items.push({
        title: run.status === "completed"
          ? "Run completed"
          : run.status === "failed"
            ? "Run failed"
            : run.status === "skipped"
              ? "Run skipped"
              : "Run stopped",
        detail: run.error || "",
        at: run.finishedAt,
        tone: classifySetupEventTone(run.status, run.status),
      });
    }

    return items.slice(-12);
  }

  function extractImportantSetupLines(run, consoleOutput) {
    const important = [];
    const seen = new Set();
    const lines = [
      ...(String(run.lastMessage || "").split(/\r?\n/g)),
      ...(String(run.summary || "").split(/\r?\n/g)),
      ...(String(consoleOutput || "").split(/\r?\n/g)),
    ];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!/error|failed|warn|warning|skip_setup|blocked|docker build|docker run|pip freeze|pytest|test|typecheck|remaining blocker|removed lock files|created setup commit|out-of-scope/i.test(line)) {
        continue;
      }
      if (seen.has(line)) continue;
      seen.add(line);
      important.push(line);
      if (important.length >= 16) break;
    }
    if (!important.length) {
      return String(consoleOutput || "").split(/\r?\n/g).map((line) => line.trim()).filter(Boolean).slice(-12);
    }
    return important;
  }

  function buildSetupOverviewMetrics(run, entries, commands) {
    const startedAtMs = run.startedAt ? new Date(run.startedAt).getTime() : NaN;
    const finishedAtMs = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null;
    const lastEntry = entries.at(-1);
    return [
      {
        label: "Current Step",
        value: run.status === "running" ? (run.stage || "Running setup") : (run.status || "—"),
        tone: run.status === "failed" ? "failed" : run.status === "completed" ? "completed" : run.status === "skipped" ? "info" : "running",
      },
      {
        label: "Elapsed",
        value: elapsedMs === null ? "—" : fmtDuration(elapsedMs),
        tone: "info",
      },
      {
        label: "Commands",
        value: String(commands.length),
        tone: "info",
      },
      {
        label: "Files Changed",
        value: String(Array.isArray(run.changedFiles) ? run.changedFiles.length : 0),
        tone: Array.isArray(run.violationFiles) && run.violationFiles.length ? "failed" : "completed",
      },
      {
        label: "Out-of-Scope Edits",
        value: String(Array.isArray(run.violationFiles) ? run.violationFiles.length : 0),
        tone: Array.isArray(run.violationFiles) && run.violationFiles.length ? "failed" : "completed",
      },
      {
        label: "Last Update",
        value: lastEntry?.message || run.lastMessage || run.summary || "No summary yet",
        tone: classifySetupEventTone(lastEntry?.message || run.status, run.status),
      },
    ];
  }

  function renderSetupMetricCards(metrics) {
    return `
      <div class="setup-metric-grid">
        ${metrics.map((metric) => `
          <div class="setup-metric-card setup-metric-${esc(metric.tone || "info")}">
            <span class="setup-metric-label">${esc(metric.label)}</span>
            <strong class="setup-metric-value">${esc(metric.value || "—")}</strong>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderSetupTimeline(items) {
    if (!items.length) {
      return `<div class="empty-state compact-empty"><p>No timeline events captured yet.</p></div>`;
    }
    return `
      <div class="setup-timeline">
        ${items.map((item) => `
          <div class="setup-timeline-item">
            <span class="setup-timeline-dot tone-${esc(item.tone || "info")}"></span>
            <div class="setup-timeline-body">
              <div class="setup-timeline-heading">
                <strong>${esc(item.title || "Update")}</strong>
                <span>${esc(item.at ? fmtDate(item.at) : "—")}</span>
              </div>
              ${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderSetupCommands(commands) {
    if (!commands.length) {
      return `<div class="empty-state compact-empty"><p>No structured command events captured yet.</p></div>`;
    }
    return `
      <div class="setup-command-list">
        ${commands.map((command) => `
          <div class="setup-command-row">
            <div class="setup-command-main">
              <code>${esc(command.command)}</code>
              ${command.detail ? `<span class="setup-command-detail">${esc(command.detail)}</span>` : ""}
            </div>
            <div class="setup-command-meta">
              ${statusBadge(command.status || "running")}
              <span>${esc(command.durationText || "—")}</span>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderSetupDetailTabs(activeTab) {
    const tabs = [
      ["overview", "Overview"],
      ["commands", "Commands"],
      ["files", "Files"],
      ["diff", "Diff"],
      ["terminal", "Raw Terminal"],
    ];
    return `
      <div class="setup-detail-tabs" role="tablist" aria-label="Setup run details">
        ${tabs.map(([id, label]) => `
          <button
            type="button"
            class="setup-detail-tab ${activeTab === id ? "active" : ""}"
            data-setup-detail-tab="${esc(id)}"
            role="tab"
            aria-selected="${activeTab === id ? "true" : "false"}"
          >${esc(label)}</button>
        `).join("")}
      </div>
    `;
  }

  function renderSetupRunsTable(runs) {
    const tbody = $("#setup-runs-tbody");
    if (!tbody) return;

    if (!Array.isArray(runs) || !runs.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📝</div><p>No setup runs yet${selectedSetupTarget ? ` for ${esc(selectedSetupTarget.label || selectedSetupTarget.fullName)}` : ""}.</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = runs.map((run) => `
      <tr class="${selectedSetupRunId === run.id ? "setup-run-row-active" : ""}">
        <td>#${run.id}</td>
        <td>${esc(run.targetLabel || run.repoFullName)}</td>
        <td>${esc(run.repoFullName)}</td>
        <td>${esc(run.profileName || "Custom")}</td>
        <td>${statusBadge(run.status)}</td>
        <td>${fmtDate(run.startedAt)}</td>
        <td>
          <button type="button" class="btn btn-sm" data-view-setup-run="${run.id}">View</button>
          ${run.status === "running" ? `<button type="button" class="btn btn-sm btn-danger" data-stop-setup-run="${run.id}">Stop</button>` : ""}
        </td>
      </tr>
    `).join("");

    $$("[data-view-setup-run]", tbody).forEach((button) => {
      button.addEventListener("click", async () => {
        selectedSetupRunId = Number(button.dataset.viewSetupRun);
        await loadSetupRunDetail(selectedSetupRunId);
        renderSetupRunsTable(runs);
      });
    });

    $$("[data-stop-setup-run]", tbody).forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api(`/api/setup/runs/${button.dataset.stopSetupRun}/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          await refreshSetupRuns();
        } catch (err) {
          alert("Failed to stop setup run: " + err.message);
          button.disabled = false;
        }
      });
    });
  }

  function renderSetupRunDetail(run) {
    const container = $("#setup-run-detail");
    const stopButton = $("#setup-stop-run");
    if (!container || !stopButton) return;
    activeSetupRunDetail = run || null;

    const existingTerminalOutput = $("[data-setup-terminal-output]", container);
    if (existingTerminalOutput && setupRunTerminalState.runId === selectedSetupRunId) {
      const distanceFromBottom = existingTerminalOutput.scrollHeight - (existingTerminalOutput.scrollTop + existingTerminalOutput.clientHeight);
      setupRunTerminalState = {
        runId: selectedSetupRunId,
        scrollTop: existingTerminalOutput.scrollTop,
        autoFollow: distanceFromBottom <= 24,
      };
    }

    if (!run) {
      stopButton.disabled = true;
      setupRunTerminalState = {
        runId: null,
        scrollTop: 0,
        autoFollow: true,
      };
      setupRunDetailState = {
        runId: null,
        tab: "overview",
      };
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🧪</div><p>Select a setup run to inspect its prompt, output, changed files, and diff.</p></div>`;
      return;
    }

    if (setupRunDetailState.runId !== run.id) {
      setupRunDetailState = {
        runId: run.id,
        tab: "overview",
      };
    }

    stopButton.disabled = run.status !== "running";
    stopButton.dataset.runId = String(run.id);
    const consoleOutput = run.liveOutput || run.stdoutExcerpt || run.stderrExcerpt || run.lastMessage || "No terminal output captured yet.";
    const worktreePath = run.worktreePath || "Not recorded yet";
    const entries = parseSetupLogEntries(run.logs || []);
    const commands = extractSetupCommands(entries);
    const timeline = buildSetupTimeline(run, entries);
    const importantLines = extractImportantSetupLines(run, consoleOutput);
    const metrics = buildSetupOverviewMetrics(run, entries, commands);
    const activeTab = setupRunDetailState.tab || "overview";
    const detailPanels = {
      overview: `
        <div class="setup-detail-section">
          <span class="setup-detail-label">Run Overview</span>
          ${renderSetupMetricCards(metrics)}
          <div class="setup-two-column">
            <div class="setup-detail-section nested">
              <span class="setup-detail-label">Timeline</span>
              ${renderSetupTimeline(timeline)}
            </div>
            <div class="setup-detail-section nested">
              <span class="setup-detail-label">Important Updates</span>
              <pre class="log-output log-output-compact">${esc(importantLines.join("\n") || "No important updates captured yet.")}</pre>
            </div>
          </div>
        </div>
      `,
      commands: `
        <div class="setup-detail-section">
          <span class="setup-detail-label">Commands</span>
          <p class="form-helper">Structured command tracking is easier to scan than the raw terminal. Running and failed commands surface here first.</p>
          ${renderSetupCommands(commands)}
        </div>
      `,
      files: `
        <div class="setup-detail-section">
          <span class="setup-detail-label">Files Changed</span>
          <div class="setup-chip-list">${renderSetupChipList(run.changedFiles, "No changed files recorded")}</div>
          <span class="setup-detail-label setup-detail-subsection">Out-of-Scope Edits</span>
          <div class="setup-chip-list">${renderSetupChipList(run.violationFiles, "No out-of-scope file edits", "danger")}</div>
          <span class="setup-detail-label setup-detail-subsection">Final Message</span>
          <pre class="log-output log-output-compact">${esc(run.lastMessage || "No final message captured yet.")}</pre>
        </div>
      `,
      diff: `
        <div class="setup-detail-section">
          <span class="setup-detail-label">Diff</span>
          <pre class="log-output log-output-compact">${esc(run.diffExcerpt || "No diff captured yet.")}</pre>
        </div>
      `,
      terminal: `
        <div class="setup-detail-section">
          <span class="setup-detail-label">Raw Terminal Output</span>
          <p class="form-helper">This is the full raw stream from Codex and the setup commands. Use it for deep debugging after checking Overview and Commands first.</p>
          <pre class="log-output" data-setup-terminal-output="1">${esc(consoleOutput)}</pre>
        </div>
      `,
    };

    container.innerHTML = `
      <div class="setup-detail-grid">
        <div class="setup-detail-summary">
          <div class="setup-run-title">
            <strong>Run #${run.id}</strong>
            ${statusBadge(run.status)}
            <span class="badge badge-info">${esc(run.profileName || "Custom")}</span>
          </div>
          <dl class="detail-kv setup-detail-meta">
            <dt>Repo</dt><dd>${esc(run.repoFullName)}</dd>
            <dt>Target</dt><dd>${esc(run.targetLabel || run.repoFullName)}</dd>
            <dt>Started</dt><dd>${fmtDate(run.startedAt)}</dd>
            <dt>Finished</dt><dd>${fmtDate(run.finishedAt)}</dd>
            <dt>Clone Root</dt><dd><code>${esc(run.cloneRootPath || "—")}</code></dd>
            <dt>Sandbox</dt><dd>${esc(run.sandboxMode)}</dd>
            <dt>Model</dt><dd>${esc(run.model || "Default Codex CLI model")}</dd>
            <dt>Worktree</dt><dd><code>${esc(worktreePath)}</code></dd>
          </dl>
          <p class="setup-summary-text">${esc(run.summary || run.error || "No summary available yet.")}</p>
          ${renderSetupMetricCards(metrics.slice(0, 3))}
        </div>
        <div class="setup-detail-prompt">
          <strong>Configured Scope</strong>
          <p class="form-helper">Context files, writable paths, the validation prompt, and the clone root are copied into the run at start time.</p>
          <div class="setup-detail-section">
            <span class="setup-detail-label">Prompt</span>
            <pre class="log-output log-output-compact">${esc(run.prompt || "")}</pre>
          </div>
          <div class="setup-detail-section">
            <span class="setup-detail-label">Context Paths</span>
            <div class="setup-chip-list">${renderSetupChipList(run.contextPaths, "No context paths configured")}</div>
          </div>
          <div class="setup-detail-section">
            <span class="setup-detail-label">Writable Paths</span>
            <div class="setup-chip-list">${renderSetupChipList(run.writablePaths, "No writable path restrictions configured")}</div>
          </div>
          <div class="setup-detail-section">
            <span class="setup-detail-label">Validation Prompt</span>
            <pre class="log-output log-output-compact">${esc(run.validationPrompt || "No validation prompt configured.")}</pre>
          </div>
        </div>
      </div>
      <div class="setup-output-stack">
        ${renderSetupDetailTabs(activeTab)}
        ${detailPanels[activeTab] || detailPanels.overview}
      </div>
    `;

    $$("[data-setup-detail-tab]", container).forEach((button) => {
      button.addEventListener("click", () => {
        setupRunDetailState = {
          runId: run.id,
          tab: button.dataset.setupDetailTab || "overview",
        };
        renderSetupRunDetail(activeSetupRunDetail);
      });
    });

    const terminalOutput = $("[data-setup-terminal-output]", container);
    if (terminalOutput) {
      const shouldAutoFollow = setupRunTerminalState.runId !== run.id
        ? run.status === "running"
        : setupRunTerminalState.autoFollow;
      terminalOutput.scrollTop = shouldAutoFollow
        ? terminalOutput.scrollHeight
        : Math.min(setupRunTerminalState.scrollTop, terminalOutput.scrollHeight);
      setupRunTerminalState = {
        runId: run.id,
        scrollTop: terminalOutput.scrollTop,
        autoFollow: shouldAutoFollow,
      };
    }
  }

  async function loadSetupRunDetail(runId) {
    if (!runId) {
      renderSetupRunDetail(null);
      return null;
    }
    const data = await api(`/api/setup/runs/${runId}`);
    renderSetupRunDetail(data);
    return data;
  }

  function stopSetupRunPolling() {
    if (setupRunPoller) {
      clearInterval(setupRunPoller);
      setupRunPoller = null;
    }
    setupRunPollInFlight = false;
  }

  function ensureSetupRunPolling(runs) {
    const hasRunning = Array.isArray(runs) && runs.some((run) => run.status === "running");
    if (!hasRunning || currentPage !== "setup") {
      stopSetupRunPolling();
      return;
    }
    if (setupRunPoller) return;
    setupRunPoller = setInterval(async () => {
      if (setupRunPollInFlight || currentPage !== "setup") return;
      setupRunPollInFlight = true;
      try {
        await refreshSetupRuns();
      } catch {
        /* ignore transient setup polling errors */
      } finally {
        setupRunPollInFlight = false;
      }
    }, 2000);
  }

  async function refreshSetupRuns() {
    const params = new URLSearchParams({ limit: "20" });
    if (selectedSetupTarget?.type === "issue" && selectedSetupTarget?.id) {
      params.set("issueId", String(selectedSetupTarget.id));
    } else if (selectedSetupTarget?.repoId) {
      params.set("repoId", String(selectedSetupTarget.repoId));
    }
    const data = await api(`/api/setup/runs?${params.toString()}`);
    const runs = Array.isArray(data.rows) ? data.rows : [];
    if (selectedSetupRunId && !runs.some((run) => run.id === selectedSetupRunId)) {
      selectedSetupRunId = runs[0]?.id || null;
    }
    if (!selectedSetupRunId && runs.length) {
      selectedSetupRunId = runs[0].id;
    }
    renderSetupRunsTable(runs);
    ensureSetupRunPolling(runs);
    if (selectedSetupRunId) {
      await loadSetupRunDetail(selectedSetupRunId);
    } else {
      renderSetupRunDetail(null);
    }
  }

  async function loadSetup() {
    renderSetupSelectedRepo();
    await loadSetupProfiles();
    await refreshSetupRuns();
  }

  $("#setup-clear-target").addEventListener("click", async () => {
    setupProfileAutoSelectPending = true;
    selectedSetupTarget = null;
    selectedSetupRunId = null;
    renderSetupSelectedRepo();
    await refreshSetupRuns();
  });

  $("#setup-profile-select").addEventListener("change", () => {
    setupProfileAutoSelectPending = false;
  });

  $("#setup-new-profile").addEventListener("click", () => {
    editingSetupProfileId = null;
    populateSetupProfileForm(null);
    renderSetupProfileList();
  });

  $("#setup-reset-profile").addEventListener("click", () => {
    if (!editingSetupProfileId) {
      populateSetupProfileForm(null);
      return;
    }
    const profile = setupProfilesCache.find((item) => item.id === editingSetupProfileId);
    populateSetupProfileForm(profile || null);
  });

  $("#setup-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = $("#setup-save-profile");
    const payload = setupProfilePayloadFromForm();
    const editingId = Number($("#setup-profile-id").value);
    submitButton.disabled = true;
    submitButton.textContent = editingId ? "Saving…" : "Creating…";
    try {
      const profile = await api(editingId ? `/api/setup/profiles/${editingId}` : "/api/setup/profiles", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      editingSetupProfileId = profile.id;
      await loadSetupProfiles();
    } catch (err) {
      alert("Failed to save setup profile: " + err.message);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Save Profile";
    }
  });

  $("#setup-delete-profile").addEventListener("click", async () => {
    const profileId = Number($("#setup-profile-id").value);
    if (!profileId) return;
    if (!confirm("Delete this setup profile? Existing runs will keep their copied prompt and file scopes.")) return;
    const button = $("#setup-delete-profile");
    button.disabled = true;
    try {
      await api(`/api/setup/profiles/${profileId}`, { method: "DELETE" });
      editingSetupProfileId = null;
      await loadSetupProfiles();
    } catch (err) {
      alert("Failed to delete setup profile: " + err.message);
      button.disabled = false;
    }
  });

  $("#setup-run-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedSetupTarget?.id) {
      alert("Choose a repo or issue from the Repos or Issues page first.");
      return;
    }
    const profileId = Number($("#setup-profile-select").value);
    if (!profileId) {
      alert("Create or select a setup profile first.");
      return;
    }
    const button = $("#setup-start-button");
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const path = selectedSetupTarget.type === "issue"
        ? `/api/issues/${selectedSetupTarget.id}/setup`
        : `/api/repos/${selectedSetupTarget.id}/setup`;
      const run = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      selectedSetupRunId = run.id;
      await refreshSetupRuns();
    } catch (err) {
      alert("Failed to start setup task: " + err.message);
    } finally {
      button.disabled = setupProfilesCache.length === 0 || !selectedSetupTarget?.id;
      button.textContent = "Start Setup";
    }
  });

  $("#setup-refresh-runs").addEventListener("click", async () => {
    try {
      await refreshSetupRuns();
    } catch (err) {
      alert("Failed to refresh setup runs: " + err.message);
    }
  });

  $("#setup-stop-run").addEventListener("click", async () => {
    const runId = Number($("#setup-stop-run").dataset.runId);
    if (!runId) return;
    const button = $("#setup-stop-run");
    button.disabled = true;
    try {
      await api(`/api/setup/runs/${runId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      await refreshSetupRuns();
    } catch (err) {
      alert("Failed to stop setup run: " + err.message);
      button.disabled = false;
    }
  });

  /* ---- Accepted ---- */
  let acceptedPage = 0;
  const ACCEPTED_PER_PAGE = 10;
  let acceptedReviewFilter = "all";
  let acceptedRepoFilter = "";
  let acceptedDockerFilter = "all";
  let acceptedSort = "merged_desc";
  let acceptedDetailCandidateId = null;
  let acceptedTestRunPoller = null;
  let acceptedTestReloadHandler = null;
  let acceptedCodexReviewPoller = null;
  let codexReviewReloadHandler = null;
  const activeAcceptedTestRuns = new Set();
  const activeAcceptedCodexReviews = new Map();
  const expandedAcceptedRows = new Set();
  const CODEX_AXIS_LABELS = {
    preferred_output: "Preferred Output",
    logic_and_correctness: "Logic and Correctness",
    naming_and_clarity: "Naming and Clarity",
    organization_and_modularity: "Organization and Modularity",
    interface_design: "Interface Design",
    error_handling: "Error Handling",
    comments_and_documentation: "Comments and Documentation",
    review_and_production_readiness: "Review / Production Readiness",
  };
  const CODEX_AXIS_OPTIONS = [
    { value: "slight_a", label: "Slight A" },
    { value: "a", label: "A" },
    { value: "strong_a", label: "Strong A" },
    { value: "slight_b", label: "Slight B" },
    { value: "b", label: "B" },
    { value: "strong_b", label: "Strong B" },
  ];

  function manualReproUsage(details) {
    const state = details?.manualRepro || {};
    return {
      used: Boolean(state.used),
      usedAt: typeof state.usedAt === "string" && state.usedAt ? state.usedAt : null,
    };
  }

  function reviewQueueState(details) {
    const state = details?.reviewQueue || {};
    return {
      status: ["reviewing", "approved", "follow_up"].includes(state.status) ? state.status : "new",
      notes: typeof state.notes === "string" ? state.notes : "",
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    };
  }

  function manualReviewState(details) {
    const state = details?.manualReview || {};
    return {
      rejected: Boolean(state.rejected),
      rejectedAt: typeof state.rejectedAt === "string" ? state.rejectedAt : null,
      reason: typeof state.reason === "string" ? state.reason : "",
    };
  }

  function acceptedDockerTestState(details) {
    const state = details?.acceptedTest || {};
    const dockerfile = state.dockerfile || {};
    const lastRun = state.lastRun || {};
    return {
      dockerfile: {
        path: typeof dockerfile.path === "string" && dockerfile.path ? dockerfile.path : "Dockerfile",
        source: typeof dockerfile.source === "string" ? dockerfile.source : "source",
        reasoningSummary: typeof dockerfile.reasoningSummary === "string" ? dockerfile.reasoningSummary : "",
        updatedAt: typeof dockerfile.updatedAt === "string" ? dockerfile.updatedAt : null,
        sha256: typeof dockerfile.sha256 === "string" ? dockerfile.sha256 : "",
      },
      lastRun: {
        success: Boolean(lastRun.success),
        summary: typeof lastRun.summary === "string" ? lastRun.summary : "",
        startedAt: typeof lastRun.startedAt === "string" ? lastRun.startedAt : null,
        finishedAt: typeof lastRun.finishedAt === "string" ? lastRun.finishedAt : null,
        testCommand: Array.isArray(lastRun.testCommand) ? lastRun.testCommand : [],
      },
    };
  }

  function acceptedAnalysisState(details) {
    const analysis = details?.analysis || {};
    return {
      relevantSourceFiles: Array.isArray(analysis.relevantSourceFiles) ? analysis.relevantSourceFiles : [],
      relevantTestFiles: Array.isArray(analysis.relevantTestFiles) ? analysis.relevantTestFiles : [],
      codeLinesChanged: Number(analysis.codeLinesChanged || 0),
      touchedDirectories: Array.isArray(analysis.touchedDirectories) ? analysis.touchedDirectories : [],
    };
  }

  function acceptedGeminiReviewState(details) {
    const state = details?.geminiReview || {};
    const issues = Array.isArray(state.issues) ? state.issues : [];
    const issueMap = new Map();
    issues.forEach((issue) => {
      const key = `${issue.owner}/${issue.repo}#${issue.number}`;
      issueMap.set(key, issue);
    });
    const normalizedStatus = ["accepted_by_gemini", "not_accepted_by_gemini", "mixed"].includes(state.status)
      ? state.status
      : (issues.every((issue) => issue?.status === "accepted_by_gemini")
        ? "accepted_by_gemini"
        : (issues.some((issue) => issue?.status === "accepted_by_gemini") ? "mixed" : "not_accepted_by_gemini"));
    return {
      status: issues.length ? normalizedStatus : "pending",
      summary: typeof state.summary === "string" ? state.summary : "",
      analyzedAt: typeof state.analyzedAt === "string" ? state.analyzedAt : null,
      issues,
      issueMap,
    };
  }

  function acceptedGeminiBadge(review) {
    if (!review || review.status === "pending") {
      return '<span class="badge badge-info">Gemini Not Run</span>';
    }
    if (review.status === "accepted_by_gemini") {
      return '<span class="badge badge-completed">Accepted By Gemini</span>';
    }
    if (review.status === "mixed") {
      return '<span class="badge badge-warn">Mixed Gemini Review</span>';
    }
    return '<span class="badge badge-rejected">Not Accepted By Gemini</span>';
  }

  function acceptedGeminiIssueBadge(issueReview) {
    if (!issueReview) {
      return '<span class="badge badge-info">Gemini Pending</span>';
    }
    return issueReview.status === "accepted_by_gemini"
      ? '<span class="badge badge-completed">Accepted By Gemini</span>'
      : '<span class="badge badge-rejected">Not Accepted By Gemini</span>';
  }

  function acceptedDockerfileSourceLabel(source) {
    return {
      source: "Source Dockerfile",
      gemini: "Gemini Test Dockerfile",
      gemini_fix: "Gemini Fixed Dockerfile",
      manual: "Manual Dockerfile",
    }[source] || "Dockerfile";
  }

  function acceptedDockerRunBadge(activeState, testState) {
    if (activeState?.status === "running") {
      return '<span class="badge badge-running">Docker Tests Running</span>';
    }
    if (testState.lastRun.finishedAt) {
      return `<span class="badge ${testState.lastRun.success ? "badge-completed" : "badge-rejected"}">${testState.lastRun.success ? "Docker Tests Passed" : "Docker Tests Failed"}</span>`;
    }
    return '<span class="badge badge-warn">Docker Tests Not Run</span>';
  }

  function codexTaskState(details) {
    const state = details?.codexTask;
    if (!state || typeof state.hfiUuid !== "string" || !state.hfiUuid.trim()) return null;
    return {
      hfiUuid: state.hfiUuid,
      originalRepoPath: typeof state.originalRepoPath === "string" ? state.originalRepoPath : "",
      worktreeAPath: typeof state.worktreeAPath === "string" ? state.worktreeAPath : "",
      worktreeBPath: typeof state.worktreeBPath === "string" ? state.worktreeBPath : "",
      testCommand: typeof state.testCommand === "string" ? state.testCommand : "",
      currentRound: Number(state.currentRound) || 1,
      maxPrompts: Number(state.maxPrompts) || 4,
      issue: state.issue || null,
      prContext: state.prContext || null,
      prompts: Array.isArray(state.prompts) ? state.prompts : [],
      rounds: Array.isArray(state.rounds) ? state.rounds : [],
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
    };
  }

  function codexRound(task, round) {
    return (task?.rounds || []).find((item) => Number(item.round) === Number(round)) || null;
  }

  function codexPrompt(task, round) {
    return (task?.prompts || []).find((item) => Number(item.round) === Number(round))?.prompt || "";
  }

  function codexLastCompletedRound(task) {
    return (task?.rounds || [])
      .filter((item) => item?.reviewDraft)
      .reduce((maxRound, item) => Math.max(maxRound, Number(item.round) || 0), 0);
  }

  function codexTmux(task) {
    if (!task?.hfiUuid) return null;
    return {
      attachA: `tmux attach -t ${task.hfiUuid}-A`,
      attachB: `tmux attach -t ${task.hfiUuid}-B`,
    };
  }

  function codexReviewBadge(activeReview, task) {
    if (activeReview?.status === "running") {
      return '<span class="badge badge-running">Codex Review Running</span>';
    }
    if ((task?.rounds || []).some((round) => round?.reviewDraft)) {
      return '<span class="badge badge-completed">Draft Reviews Saved</span>';
    }
    return '<span class="badge badge-warn">No Codex Review Yet</span>';
  }

  function renderCodexAxisSelect(candidateId, round, axis, selected) {
    return `
      <label class="codex-axis-row">
        <span>${esc(CODEX_AXIS_LABELS[axis] || axis)}</span>
        <select data-codex-axis="${candidateId}" data-round="${round}" data-axis="${axis}">
          ${CODEX_AXIS_OPTIONS.map((option) => `
            <option value="${option.value}" ${selected === option.value ? "selected" : ""}>${option.label}</option>
          `).join("")}
        </select>
      </label>
    `;
  }

  function renderCodexDraftEditor(candidateId, round, draft) {
    if (!draft) return "";
    const axes = draft.axes || {};
    return `
      <div class="codex-draft-editor">
        <div class="codex-draft-header">
          <strong>Round ${round} Draft Review</strong>
          <div class="accepted-card-actions">
            <button type="button" class="btn btn-sm btn-info" data-copy-codex-next-prompt="${candidateId}" data-round="${round}">Copy Next Prompt</button>
            <button type="button" class="btn btn-sm btn-info" data-save-codex-draft="${candidateId}" data-round="${round}">Save Draft</button>
          </div>
        </div>
        <div class="codex-draft-grid">
          <label class="form-group">
            <span>Winner</span>
            <select data-codex-draft-winner="${candidateId}" data-round="${round}">
              <option value="A" ${draft.winner === "A" ? "selected" : ""}>A</option>
              <option value="B" ${draft.winner === "B" ? "selected" : ""}>B</option>
            </select>
          </label>
          <label class="form-group">
            <span>Generated</span>
            <input type="text" value="${esc(fmtDate(draft.generatedAt))}" readonly>
          </label>
        </div>
        <label class="form-group">
          <span>Response A Pros</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="modelA.pros" class="accepted-review-notes">${esc(draft.modelA?.pros || "")}</textarea>
        </label>
        <label class="form-group">
          <span>Response A Cons</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="modelA.cons" class="accepted-review-notes">${esc(draft.modelA?.cons || "")}</textarea>
        </label>
        <label class="form-group">
          <span>Response B Pros</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="modelB.pros" class="accepted-review-notes">${esc(draft.modelB?.pros || "")}</textarea>
        </label>
        <label class="form-group">
          <span>Response B Cons</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="modelB.cons" class="accepted-review-notes">${esc(draft.modelB?.cons || "")}</textarea>
        </label>
        <div class="codex-axis-grid">
          ${Object.keys(CODEX_AXIS_LABELS).map((axis) => renderCodexAxisSelect(candidateId, round, axis, axes[axis] || "slight_a")).join("")}
        </div>
        <label class="form-group">
          <span>Overall Justification</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="overallJustification" class="accepted-review-notes">${esc(draft.overallJustification || "")}</textarea>
        </label>
        <label class="form-group">
          <span>Winner Unresolved Cons</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="winnerUnresolvedCons" class="accepted-review-notes">${esc(Array.isArray(draft.winnerUnresolvedCons) ? draft.winnerUnresolvedCons.join("\n") : "")}</textarea>
        </label>
        <label class="form-group">
          <span>Next Prompt</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="nextPrompt" class="accepted-review-notes">${esc(draft.nextPrompt || "")}</textarea>
        </label>
        <label class="form-group">
          <span>Confidence Notes</span>
          <textarea data-codex-field="${candidateId}" data-round="${round}" data-field="confidenceNotes" class="accepted-review-notes">${esc(draft.confidenceNotes || "")}</textarea>
        </label>
      </div>
    `;
  }

  function renderCodexTaskSummary(row, task, activeReview) {
    const promptOne = task ? codexPrompt(task, 1) : "";
    return `
      <div class="accepted-review-panel codex-task-summary">
        <div class="accepted-review-header">
          <div class="accepted-card-title">
            <strong>Codex Task Workspace</strong>
            ${codexReviewBadge(activeReview, task)}
            ${task ? `<span class="badge badge-info">Round ${task.currentRound} of ${task.maxPrompts}</span>` : '<span class="badge badge-warn">Not Started</span>'}
          </div>
          <span class="accepted-review-meta">${task?.updatedAt ? `Updated ${fmtDate(task.updatedAt)}` : "No task has been started for this candidate yet."}</span>
        </div>
        <p>${task
          ? `Prompt 1 is ready${promptOne ? ` (${promptOne.split("\n")[0]})` : ""}. Open the dedicated Tasks page to manage the full workflow.`
          : "Start the task from the dedicated Tasks page so Prompt 1, tmux capture, and round reviews stay in one workspace."}</p>
        <div class="accepted-card-actions">
          <button type="button" class="btn btn-sm btn-info" data-open-task-workspace="${row.id}">${task ? "Open Task Workspace" : "Start Task In Workspace"}</button>
        </div>
      </div>
    `;
  }

  function renderCodexTaskPanel(row, task, activeReview) {
    const tmux = codexTmux(task);
    const currentRound = task?.currentRound || 1;
    const lastCompletedRound = codexLastCompletedRound(task);
    const currentPrompt = task ? codexPrompt(task, currentRound) : "";
    const promptOne = task ? codexPrompt(task, 1) : "";
    const issueTitle = task?.issue?.title || "";
    const issueBody = task?.issue?.body || "";
    const pr = task?.prContext || null;
    const reviewRunPanel = `
      <div class="tests-unable-rerun-panel accepted-test-run-panel codex-review-run-panel" data-codex-review-panel="${row.id}" hidden>
        <div class="tests-unable-rerun-meta">
          <span class="badge badge-running" data-codex-review-status-badge="${row.id}">running</span>
          <span class="tests-unable-rerun-stage" data-codex-review-stage="${row.id}">Starting Codex review…</span>
        </div>
        <pre class="log-output log-output-compact tests-unable-live-output" data-codex-review-output="${row.id}">Waiting for Codex output…</pre>
      </div>
    `;
    if (!task) {
      return `
        <div class="accepted-review-panel codex-task-panel">
          <div class="accepted-review-header">
            <div class="accepted-card-title">
              <strong>Codex Task</strong>
              <span class="badge badge-warn">Not Started</span>
            </div>
            <span class="accepted-review-meta">Generate or regenerate a Codex-rewritten Prompt 1 and Codex review drafts from the issue, actual PR context, worktrees, and tmux captures.</span>
          </div>
          <div class="codex-task-form codex-task-grid">
            <label class="form-group">
              <span>HFI UUID</span>
              <input type="text" data-codex-start-field="${row.id}" data-field="hfiUuid" placeholder="uuid">
            </label>
            <label class="form-group">
              <span>Original Repo Path</span>
              <input type="text" data-codex-start-field="${row.id}" data-field="originalRepoPath" placeholder="/abs/path/to/repo">
            </label>
            <label class="form-group">
              <span>Worktree A Path</span>
              <input type="text" data-codex-start-field="${row.id}" data-field="worktreeAPath" placeholder="/abs/path/to/worktree-a">
            </label>
            <label class="form-group">
              <span>Worktree B Path</span>
              <input type="text" data-codex-start-field="${row.id}" data-field="worktreeBPath" placeholder="/abs/path/to/worktree-b">
            </label>
            <label class="form-group codex-task-wide">
              <span>Test Command (Optional)</span>
              <input type="text" data-codex-start-field="${row.id}" data-field="testCommand" placeholder="npm test">
            </label>
          </div>
          <div class="accepted-card-actions">
            <button type="button" class="btn btn-sm btn-info" data-start-codex-task="${row.id}">Start Task</button>
          </div>
        </div>
      `;
    }

    return `
      <div class="accepted-review-panel codex-task-panel">
        <div class="accepted-review-header">
          <div class="accepted-card-title">
            <strong>Codex Task</strong>
            <span class="badge badge-info">Round ${currentRound} of ${task.maxPrompts}</span>
            ${codexReviewBadge(activeReview, task)}
          </div>
          <span class="accepted-review-meta">${task.updatedAt ? `Updated ${fmtDate(task.updatedAt)}` : "Not updated yet"}</span>
        </div>
        <div class="codex-task-form codex-task-grid">
          <label class="form-group">
            <span>HFI UUID</span>
            <input type="text" data-codex-start-field="${row.id}" data-field="hfiUuid" value="${esc(task.hfiUuid)}">
          </label>
          <label class="form-group">
            <span>Original Repo Path</span>
            <input type="text" data-codex-start-field="${row.id}" data-field="originalRepoPath" value="${esc(task.originalRepoPath)}">
          </label>
          <label class="form-group">
            <span>Worktree A Path</span>
            <input type="text" data-codex-start-field="${row.id}" data-field="worktreeAPath" value="${esc(task.worktreeAPath)}">
          </label>
          <label class="form-group">
            <span>Worktree B Path</span>
            <input type="text" data-codex-start-field="${row.id}" data-field="worktreeBPath" value="${esc(task.worktreeBPath)}">
          </label>
          <label class="form-group codex-task-wide">
            <span>Test Command (Optional)</span>
            <input type="text" data-codex-start-field="${row.id}" data-field="testCommand" value="${esc(task.testCommand || "")}">
          </label>
        </div>
        <div class="accepted-card-actions">
          <button type="button" class="btn btn-sm btn-info" data-update-codex-task="${row.id}">Update Task Settings</button>
          <button type="button" class="btn btn-sm btn-info" data-start-codex-task="${row.id}">Restart Task</button>
          ${lastCompletedRound ? `<button type="button" class="btn btn-sm btn-info" data-reopen-codex-round="${row.id}">Reopen Last Iteration</button>` : ""}
        </div>
        <div class="codex-two-column">
          <div class="codex-info-card">
            <div class="manual-repro-header">
              <strong>Original Issue</strong>
            </div>
            <p class="accepted-pr-title">${esc(issueTitle)}</p>
            <pre class="log-output log-output-compact codex-prompt-output">${esc(issueBody || "No issue body saved for this candidate.")}</pre>
          </div>
          <div class="codex-info-card">
            <div class="manual-repro-header">
              <strong>Prompt 1</strong>
              <button type="button" class="btn btn-sm btn-info" data-copy-codex-prompt="${row.id}" data-round="1">Copy</button>
            </div>
            <pre class="log-output log-output-compact codex-prompt-output" data-codex-prompt-text="${row.id}" data-round-prompt="1">${esc(promptOne)}</pre>
          </div>
        </div>
        <div class="codex-info-card">
          <div class="manual-repro-header">
            <strong>Actual PR Context</strong>
          </div>
          <p><strong>${esc(pr?.title || row.pr_title || "No PR title saved")}</strong>${pr?.url || row.pr_url ? ` <a href="${esc(pr?.url || row.pr_url)}" target="_blank" class="repo-link">Open PR</a>` : ""}</p>
          <p>${esc(pr?.body || "No PR body was available. The tool still uses the issue, file summary, and worktree evidence.")}</p>
          <p>${typeof pr?.changedFilesCount === "number" ? `${pr.changedFilesCount} changed file(s)` : "Changed-file count unavailable"}</p>
          ${Array.isArray(pr?.changedFiles) && pr.changedFiles.length ? `<div class="dockerfile-choice-list">${pr.changedFiles.map((file) => `<span class="dockerfile-choice">${esc(file.filename)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="codex-info-card">
          <div class="manual-repro-header">
            <strong>Tmux Sessions</strong>
          </div>
          <p>The automatic review captures only the HFI trajectory sessions. Your own <code>task</code> session stays manual.</p>
          <pre class="log-output log-output-compact codex-prompt-output">${esc(tmux?.attachA || "")}
${esc(tmux?.attachB || "")}</pre>
        </div>
        <div class="codex-info-card">
          <div class="manual-repro-header">
            <strong>Current Round Prompt</strong>
            <button type="button" class="btn btn-sm btn-info" data-copy-codex-prompt="${row.id}" data-round="${currentRound}">Copy</button>
          </div>
          <pre class="log-output log-output-compact codex-prompt-output" data-codex-prompt-text="${row.id}" data-round-prompt="${currentRound}">${esc(currentPrompt || "No prompt saved for this round yet.")}</pre>
        </div>
        <div class="codex-review-controls">
          <label class="form-group">
            <span>Round ${currentRound} Notes For Response A</span>
            <textarea class="accepted-review-notes" data-codex-round-notes="${row.id}" data-round="${currentRound}" data-side="A">${esc(codexRound(task, currentRound)?.notesA || "")}</textarea>
          </label>
          <label class="form-group">
            <span>Round ${currentRound} Notes For Response B</span>
            <textarea class="accepted-review-notes" data-codex-round-notes="${row.id}" data-round="${currentRound}" data-side="B">${esc(codexRound(task, currentRound)?.notesB || "")}</textarea>
          </label>
          <div class="accepted-card-actions">
            <button type="button" class="btn btn-sm btn-info" data-run-codex-review="${row.id}" data-round="${currentRound}">Generate Review</button>
          </div>
        </div>
        ${reviewRunPanel}
        ${(task.rounds || []).map((savedRound) => renderCodexDraftEditor(row.id, savedRound.round, savedRound.reviewDraft)).join("")}
      </div>
    `;
  }

  function renderAcceptedCodexReviewState(container, candidateId, state) {
    const panel = $(`[data-codex-review-panel="${candidateId}"]`, container);
    const badge = $(`[data-codex-review-status-badge="${candidateId}"]`, container);
    const stage = $(`[data-codex-review-stage="${candidateId}"]`, container);
    const output = $(`[data-codex-review-output="${candidateId}"]`, container);
    const runButton = $(`[data-run-codex-review="${candidateId}"]`, container);
    if (!panel || !badge || !stage || !output || !runButton) return;

    const status = state?.status || "idle";
    const isRunning = status === "running";
    panel.hidden = status === "idle";
    badge.className = `badge ${badgeClassForStatus(status)}`;
    badge.textContent = status;
    stage.textContent = state?.stage || (isRunning ? "Running Codex review…" : "Idle");
    output.textContent = state?.liveOutput || (Array.isArray(state?.logs) ? state.logs.join("\n") : "Waiting for Codex output…");
    output.scrollTop = output.scrollHeight;
    runButton.disabled = isRunning;
    runButton.textContent = isRunning ? "Generating Review…" : "Generate Review";
  }

  function stopAcceptedCodexReviewPolling() {
    if (acceptedCodexReviewPoller) {
      clearInterval(acceptedCodexReviewPoller);
      acceptedCodexReviewPoller = null;
    }
    codexReviewReloadHandler = null;
  }

  async function pollAcceptedCodexReviewStates(container) {
    const entries = [...activeAcceptedCodexReviews.entries()];
    if (!entries.length) {
      stopAcceptedCodexReviewPolling();
      return;
    }

    try {
      const states = await Promise.all(entries.map(async ([candidateId, round]) => {
        try {
          return await api(`/api/accepted/${candidateId}/codex-task/round/${round}/status`);
        } catch (err) {
          return { candidateId, round, status: "failed", stage: err.message, liveOutput: "", logs: [], error: err.message };
        }
      }));

      let shouldReload = false;
      for (const state of states) {
        renderAcceptedCodexReviewState(container, String(state.candidateId), state);
        if (state.status === "running") continue;
        activeAcceptedCodexReviews.delete(String(state.candidateId));
        shouldReload = true;
      }

      if (shouldReload) {
        if (typeof codexReviewReloadHandler === "function") {
          await codexReviewReloadHandler();
        }
        return;
      }

      if (!activeAcceptedCodexReviews.size) {
        stopAcceptedCodexReviewPolling();
      }
    } catch {
      /* keep polling on transient failures */
    }
  }

  function ensureCodexReviewPolling(container, reloadHandler) {
    codexReviewReloadHandler = reloadHandler;
    if (!activeAcceptedCodexReviews.size || acceptedCodexReviewPoller) return;
    acceptedCodexReviewPoller = setInterval(() => {
      void pollAcceptedCodexReviewStates(container);
    }, 1500);
  }

  function readCodexDraftFromDom(container, candidateId, round) {
    const winner = $(`[data-codex-draft-winner="${candidateId}"][data-round="${round}"]`, container)?.value || "A";
    const readField = (field) => $(`[data-codex-field="${candidateId}"][data-round="${round}"][data-field="${field}"]`, container)?.value || "";
    const axes = {};
    Object.keys(CODEX_AXIS_LABELS).forEach((axis) => {
      axes[axis] = $(`[data-codex-axis="${candidateId}"][data-round="${round}"][data-axis="${axis}"]`, container)?.value || "slight_a";
    });
    return {
      winner,
      modelA: {
        pros: readField("modelA.pros"),
        cons: readField("modelA.cons"),
      },
      modelB: {
        pros: readField("modelB.pros"),
        cons: readField("modelB.cons"),
      },
      axes,
      overallJustification: readField("overallJustification"),
      winnerUnresolvedCons: readField("winnerUnresolvedCons").split("\n").map((item) => item.trim()).filter(Boolean),
      nextPrompt: readField("nextPrompt"),
      confidenceNotes: readField("confidenceNotes"),
    };
  }

  function bindCodexTaskInteractions(container, reloadHandler) {
    $$("[data-copy-codex-prompt]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.copyCodexPrompt;
        const round = button.dataset.round;
        const output = $(`[data-codex-prompt-text="${candidateId}"][data-round-prompt="${round}"]`, container);
        if (!output) return;
        const originalText = button.textContent;
        button.disabled = true;
        try {
          await copyTextToClipboard(output.textContent || "");
          button.textContent = "Copied";
        } catch (err) {
          alert("Failed to copy prompt: " + err.message);
        } finally {
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 1200);
        }
      });
    });

    $$("[data-start-codex-task]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.startCodexTask;
        const readField = (field) => $(`[data-codex-start-field="${candidateId}"][data-field="${field}"]`, container)?.value?.trim() || "";
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/start-task`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hfiUuid: readField("hfiUuid"),
              originalRepoPath: readField("originalRepoPath"),
              worktreeAPath: readField("worktreeAPath"),
              worktreeBPath: readField("worktreeBPath"),
              testCommand: readField("testCommand") || undefined,
            }),
          });
          await reloadHandler();
        } catch (err) {
          alert("Failed to start task: " + err.message);
          button.disabled = false;
        }
      });
    });

    $$("[data-update-codex-task]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.updateCodexTask;
        const readField = (field) => $(`[data-codex-start-field="${candidateId}"][data-field="${field}"]`, container)?.value?.trim() || "";
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/codex-task/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hfiUuid: readField("hfiUuid"),
              originalRepoPath: readField("originalRepoPath"),
              worktreeAPath: readField("worktreeAPath"),
              worktreeBPath: readField("worktreeBPath"),
              testCommand: readField("testCommand") || undefined,
            }),
          });
          await reloadHandler();
        } catch (err) {
          alert("Failed to update task settings: " + err.message);
          button.disabled = false;
        }
      });
    });

    $$("[data-reopen-codex-round]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.reopenCodexRound;
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/codex-task/reopen-last-round`, {
            method: "POST",
          });
          await reloadHandler();
        } catch (err) {
          alert("Failed to reopen the last iteration: " + err.message);
          button.disabled = false;
        }
      });
    });

    $$("[data-run-codex-review]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.runCodexReview;
        const round = button.dataset.round;
        const notesA = $(`[data-codex-round-notes="${candidateId}"][data-round="${round}"][data-side="A"]`, container)?.value || "";
        const notesB = $(`[data-codex-round-notes="${candidateId}"][data-round="${round}"][data-side="B"]`, container)?.value || "";
        button.disabled = true;
        button.textContent = "Generating Review…";
        try {
          const state = await api(`/api/accepted/${candidateId}/codex-task/round/${round}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notesA, notesB }),
          });
          activeAcceptedCodexReviews.set(String(candidateId), Number(round));
          renderAcceptedCodexReviewState(container, candidateId, state);
          ensureCodexReviewPolling(container, reloadHandler);
          void pollAcceptedCodexReviewStates(container);
        } catch (err) {
          alert("Failed to generate Codex review: " + err.message);
          button.disabled = false;
          button.textContent = "Generate Review";
        }
      });
    });

    $$("[data-save-codex-draft]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.saveCodexDraft;
        const round = button.dataset.round;
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/codex-task/round/${round}/save-draft`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(readCodexDraftFromDom(container, candidateId, round)),
          });
          await reloadHandler();
        } catch (err) {
          alert("Failed to save Codex draft: " + err.message);
          button.disabled = false;
        }
      });
    });

    $$("[data-copy-codex-next-prompt]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.copyCodexNextPrompt;
        const round = button.dataset.round;
        const draft = readCodexDraftFromDom(container, candidateId, round);
        const originalText = button.textContent;
        button.disabled = true;
        try {
          await copyTextToClipboard(draft.nextPrompt || "");
          button.textContent = "Copied";
        } catch (err) {
          alert("Failed to copy next prompt: " + err.message);
        } finally {
          setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
          }, 1200);
        }
      });
    });
  }

  function renderAcceptedDockerfileChoices(candidateId, paths, selectedPath) {
    const uniquePaths = [...new Set((Array.isArray(paths) ? paths : []).filter((path) => typeof path === "string" && path.trim()))];
    if (!uniquePaths.length) return "";
    return `
      <div class="dockerfile-choice-list">
        ${uniquePaths.map((path) => `
          <button
            type="button"
            class="dockerfile-choice ${path === selectedPath ? "active" : ""}"
            data-accepted-dockerfile-choice="${candidateId}"
            data-accepted-dockerfile-choice-path="${esc(path)}"
          >${esc(path)}</button>
        `).join("")}
      </div>
    `;
  }

  function renderAcceptedTestRunState(container, candidateId, state) {
    const panel = $(`[data-accepted-test-panel="${candidateId}"]`, container);
    const badge = $(`[data-accepted-test-status-badge="${candidateId}"]`, container);
    const stage = $(`[data-accepted-test-stage="${candidateId}"]`, container);
    const output = $(`[data-accepted-test-output="${candidateId}"]`, container);
    const stopButton = $(`[data-stop-accepted-tests="${candidateId}"]`, container);
    const runButton = $(`[data-run-accepted-tests="${candidateId}"]`, container);
    if (!panel || !badge || !stage || !output || !stopButton || !runButton) return;

    const status = state?.status || "idle";
    const isRunning = status === "running";
    panel.hidden = status === "idle";
    badge.className = `badge ${badgeClassForStatus(status)}`;
    badge.textContent = status;
    stage.textContent = state?.stage || (isRunning ? "Starting Docker test run…" : "Idle");
    output.textContent = state?.liveOutput || (Array.isArray(state?.logs) ? state.logs.join("\n") : "Waiting for Docker output…");
    output.scrollTop = output.scrollHeight;
    stopButton.hidden = !isRunning;
    stopButton.disabled = !isRunning;
    runButton.disabled = isRunning;
    runButton.textContent = isRunning ? "Running Tests…" : "Run Tests";
  }

  function stopAcceptedTestRunPolling() {
    if (acceptedTestRunPoller) {
      clearInterval(acceptedTestRunPoller);
      acceptedTestRunPoller = null;
    }
    acceptedTestReloadHandler = null;
  }

  async function pollAcceptedTestRunStates(container) {
    const candidateIds = [...activeAcceptedTestRuns];
    if (!candidateIds.length) {
      stopAcceptedTestRunPolling();
      return;
    }

    try {
      const states = await Promise.all(candidateIds.map(async (candidateId) => {
        try {
          return await api(`/api/accepted/${candidateId}/test-run-status`);
        } catch (err) {
          return { candidateId, status: "failed", stage: err.message, liveOutput: "", logs: [], error: err.message };
        }
      }));

      let shouldReload = false;
      for (const state of states) {
        renderAcceptedTestRunState(container, String(state.candidateId), state);
        if (state.status === "running") continue;
        activeAcceptedTestRuns.delete(String(state.candidateId));
        shouldReload = true;
      }

      if (shouldReload) {
        if (typeof acceptedTestReloadHandler === "function") {
          await acceptedTestReloadHandler();
        }
        return;
      }

      if (!activeAcceptedTestRuns.size) {
        stopAcceptedTestRunPolling();
      }
    } catch {
      /* keep polling on transient failures */
    }
  }

  function ensureAcceptedTestRunPolling(container, reloadHandler) {
    acceptedTestReloadHandler = reloadHandler;
    if (!activeAcceptedTestRuns.size || acceptedTestRunPoller) return;
    acceptedTestRunPoller = setInterval(() => {
      void pollAcceptedTestRunStates(container);
    }, 1500);
  }

  async function loadAcceptedDockerfileEditor(container, candidateId, requestedPath) {
    const editor = $(`[data-accepted-dockerfile-editor="${candidateId}"]`, container);
    const toggleButton = $(`[data-toggle-accepted-dockerfile="${candidateId}"]`, container);
    const reloadButton = $(`[data-load-accepted-dockerfile="${candidateId}"]`, container);
    const pathInput = $(`[data-accepted-dockerfile-path="${candidateId}"]`, container);
    const contentInput = $(`[data-accepted-dockerfile-content="${candidateId}"]`, container);
    const status = $(`[data-accepted-dockerfile-status="${candidateId}"]`, container);
    const choices = $(`[data-accepted-dockerfile-choices="${candidateId}"]`, container);
    const reasoning = $(`[data-accepted-dockerfile-reasoning="${candidateId}"]`, container);
    if (!editor || !pathInput || !contentInput || !status || !choices || !reasoning) {
      throw new Error("accepted Dockerfile editor controls are missing");
    }

    const query = new URLSearchParams();
    const path = typeof requestedPath === "string" && requestedPath.trim()
      ? requestedPath.trim()
      : (pathInput.value.trim() || "");
    if (path) {
      query.set("path", path);
    }

    editor.hidden = false;
    editor.dataset.loaded = "loading";
    status.textContent = "Loading Dockerfile…";
    if (toggleButton) {
      toggleButton.disabled = true;
      toggleButton.textContent = "Loading Dockerfile…";
    }
    if (reloadButton) {
      reloadButton.disabled = true;
    }

    try {
      const data = await api(
        query.toString()
          ? `/api/accepted/${candidateId}/dockerfile?${query.toString()}`
          : `/api/accepted/${candidateId}/dockerfile`,
      );
      const selectedPath = data.path || "Dockerfile";
      pathInput.value = selectedPath;
      contentInput.value = data.content || "";
      editor.dataset.loaded = "true";
      editor.dataset.dockerfileSource = data.source || "source";
      editor.dataset.reasoningSummary = data.reasoningSummary || "";
      status.innerHTML = data.source === "saved"
        ? `Loaded saved <code>${esc(selectedPath)}</code>. Edit it or run tests directly.`
        : (data.exists
          ? `Loaded <code>${esc(selectedPath)}</code> from the stored pre-fix SHA. Edit it or generate a test Dockerfile with Gemini.`
          : `No Dockerfile existed at <code>${esc(selectedPath)}</code> in the stored pre-fix SHA. You can create one here before running tests.`);
      reasoning.hidden = !data.reasoningSummary;
      reasoning.textContent = data.reasoningSummary || "";
      choices.innerHTML = renderAcceptedDockerfileChoices(candidateId, data.availablePaths, selectedPath);
      $$(`[data-accepted-dockerfile-choice="${candidateId}"]`, container).forEach((button) => {
        button.addEventListener("click", async () => {
          const nextPath = button.dataset.acceptedDockerfileChoicePath || "";
          try {
            await loadAcceptedDockerfileEditor(container, candidateId, nextPath);
          } catch (err) {
            alert("Failed to load Dockerfile: " + err.message);
          }
        });
      });
      if (toggleButton) {
        toggleButton.textContent = "Hide Dockerfile";
      }
    } catch (err) {
      editor.dataset.loaded = "error";
      status.textContent = `Unable to load Dockerfile: ${err.message}`;
      choices.innerHTML = "";
      reasoning.textContent = "";
      if (toggleButton) {
        toggleButton.textContent = "Edit Dockerfile";
      }
      throw err;
    } finally {
      if (toggleButton) {
        toggleButton.disabled = false;
      }
      if (reloadButton) {
        reloadButton.disabled = false;
      }
    }
  }

  function reviewStatusLabel(status) {
    return {
      new: "New",
      reviewing: "Reviewing",
      approved: "Approved",
      follow_up: "Follow Up",
    }[status] || "New";
  }

  function reviewStatusBadge(status) {
    const badgeClass = {
      new: "badge-warn",
      reviewing: "badge-running",
      approved: "badge-completed",
      follow_up: "badge-rejected",
    }[status] || "badge-warn";
    return `<span class="badge ${badgeClass}">${reviewStatusLabel(status)}</span>`;
  }

  function renderAcceptedIssues(issues, opts = {}) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return `<p class="accepted-empty">No verified issues saved for this PR.</p>`;
    }
    const geminiReview = opts.geminiReview || acceptedGeminiReviewState({});
    return `
      <div class="accepted-issue-list">
        ${issues.map((issue) => `
          <div class="accepted-issue-item">
            <div class="accepted-issue-item-header">
              <a href="${esc(issue.url || "#")}" target="_blank" class="repo-link">
                <strong>${esc(issue.issue_repo_full_name || `${issue.owner}/${issue.repo}`)}</strong>
                <span>#${issue.number}</span>
              </a>
              ${acceptedGeminiIssueBadge(geminiReview.issueMap.get(`${issue.owner}/${issue.repo}#${issue.number}`))}
            </div>
            <span>${esc(issue.title || "Untitled issue")}</span>
            ${geminiReview.issueMap.get(`${issue.owner}/${issue.repo}#${issue.number}`)?.reasoning
              ? `<p class="accepted-issue-note">${esc(geminiReview.issueMap.get(`${issue.owner}/${issue.repo}#${issue.number}`).reasoning)}</p>`
              : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  function acceptedSortParams() {
    const [sortBy = "merged", sortDir = "desc"] = String(acceptedSort || "merged_desc").split("_");
    return {
      sortBy,
      sortDir: sortDir === "asc" ? "asc" : "desc",
    };
  }

  function populateAcceptedRepoFilter(options = []) {
    const select = $("#accepted-repo-filter");
    if (!select) return;
    const currentValue = acceptedRepoFilter;
    const currentLabel = select.selectedOptions?.[0]?.textContent?.trim() || "";
    select.innerHTML = `
      <option value="">All Repositories</option>
      ${(Array.isArray(options) ? options : []).map((option) => `
        <option value="${option.id}" ${String(option.id) === String(currentValue) ? "selected" : ""}>
          ${esc(option.full_name)} (${option.candidate_count})
        </option>
      `).join("")}
    `;
    if (currentValue && (!Array.isArray(options) || !options.some((option) => String(option.id) === String(currentValue)))) {
      select.innerHTML += `<option value="${esc(currentValue)}" selected>${esc(currentLabel || `Selected Repo (${currentValue})`)}</option>`;
    }
    select.value = currentValue || "";
  }

  function renderAcceptedSummary(total, rows) {
    renderTableSummary("#accepted-summary", total, ACCEPTED_PER_PAGE, acceptedPage);
    const summary = $("#accepted-summary");
    if (!summary || !total) return;
    const repoCount = new Set((Array.isArray(rows) ? rows : []).map((row) => String(row.repo_id))).size;
    summary.innerHTML += `<span class="summary-right">${repoCount} repo${repoCount === 1 ? "" : "s"} on this page</span>`;
  }

  function renderAcceptedToolbarHint(rows = []) {
    const hint = $("#accepted-toolbar-hint");
    if (!hint) return;
    const repoLabel = acceptedRepoFilter
      ? rows.find((row) => String(row.repo_id) === String(acceptedRepoFilter))?.repo_full_name
        || $("#accepted-repo-filter")?.selectedOptions?.[0]?.textContent?.replace(/\s+\(\d+\)$/, "")
      : "";
    const bits = [];
    if (repoLabel) {
      bits.push(`Focused on ${repoLabel}.`);
    }
    if (acceptedReviewFilter !== "all") {
      bits.push(`Review filter: ${reviewStatusLabel(acceptedReviewFilter)}.`);
    }
    if (acceptedDockerFilter !== "all") {
      bits.push(`Docker filter: ${acceptedDockerFilter.replace(/_/g, " ")}.`);
    }
    bits.push("Repository groups stay alphabetical so the table is easy to scan.");
    bits.push("Sort changes the order inside each repository group.");
    hint.textContent = bits.join(" ");
  }

  function renderAcceptedTable(rows) {
    const groups = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (!last || last.repoId !== Number(row.repo_id)) {
        groups.push({
          repoId: Number(row.repo_id),
          repoFullName: row.repo_full_name,
          repoUrl: row.repo_url,
          repoLanguage: row.repo_primary_language,
          rows: [row],
        });
      } else {
        last.rows.push(row);
      }
    }

    return groups.map((group) => {
      const issueTotal = group.rows.reduce((sum, row) => sum + (Number(row.issue_count) || (Array.isArray(row.issues) ? row.issues.length : 0)), 0);
      return `
        <tr class="accepted-group-row">
          <td colspan="11">
            <div class="accepted-group-cell">
              <div class="accepted-group-main">
                <button type="button" class="accepted-group-link" data-filter-accepted-repo="${group.repoId}">
                  ${esc(group.repoFullName)}
                </button>
                <div class="accepted-group-meta">
                  <span>${group.rows.length} accepted PR${group.rows.length === 1 ? "" : "s"}</span>
                  <span>${issueTotal} linked issue${issueTotal === 1 ? "" : "s"}</span>
                  <span>${esc(group.repoLanguage || "Language unknown")}</span>
                </div>
              </div>
              <div class="accepted-group-actions">
                <a href="${esc(group.repoUrl || "#")}" target="_blank" class="repo-link-external">Open Repo</a>
                <button type="button" class="btn btn-sm" data-filter-accepted-repo="${group.repoId}">
                  ${String(group.repoId) === String(acceptedRepoFilter) ? "Focused Repo" : "Focus Repo"}
                </button>
                <button type="button" class="btn btn-sm btn-danger" data-reject-accepted-repo="${group.repoId}" data-reject-accepted-repo-name="${esc(group.repoFullName)}">
                  Reject Repo
                </button>
              </div>
            </div>
          </td>
        </tr>
        ${group.rows.map((row) => {
          const details = row.details || {};
          const review = reviewQueueState(details);
          const usage = manualReproUsage(details);
          const manualReview = manualReviewState(details);
          const dockerTest = acceptedDockerTestState(details);
          const analysis = acceptedAnalysisState(details);
          const geminiReview = acceptedGeminiReviewState(details);
          const issueCount = Number(row.issue_count) || (Array.isArray(row.issues) ? row.issues.length : 0);
          const setupButtonLabel = Array.isArray(row.issues) && row.issues.length === 1 ? "Setup Issue" : "Setup Repo";
          return `
            <tr>
              <td>
                <button type="button" class="accepted-table-link" data-open-accepted-detail="${row.id}">
                  PR #${row.pr_number || "—"}
                </button>
              </td>
              <td>
                <button type="button" class="accepted-table-link accepted-title-link" data-open-accepted-detail="${row.id}">
                  ${esc(row.pr_title || "No PR title saved")}
                </button>
                ${manualReview.rejected ? '<span class="badge badge-rejected accepted-inline-badge">Manual Reject</span>' : ""}
              </td>
              <td>${issueCount}</td>
              <td>${analysis.relevantSourceFiles.length}</td>
              <td>${analysis.codeLinesChanged}</td>
              <td>${acceptedGeminiBadge(geminiReview)}</td>
              <td>${reviewStatusBadge(review.status)}</td>
              <td>${acceptedDockerRunBadge(row.activeTestRun || null, dockerTest)}</td>
              <td><span class="badge ${usage.used ? "badge-completed" : "badge-warn"}">${usage.used ? "Used" : "Unused"}</span></td>
              <td>${fmtDate(row.pr_merged_at || row.created_at)}</td>
              <td>
                <div class="accepted-table-actions">
                  <button type="button" class="btn btn-sm btn-info" data-open-accepted-detail="${row.id}">Details</button>
                  <button type="button" class="btn btn-sm" data-setup-accepted="${row.id}">${setupButtonLabel}</button>
                  <button type="button" class="btn btn-sm" data-open-task-workspace="${row.id}">Task</button>
                  <button type="button" class="btn btn-sm btn-danger" data-manual-reject-row="${row.id}">Reject Issue</button>
                </div>
              </td>
            </tr>
          `;
        }).join("")}
      `;
    }).join("");
  }

  function bindAcceptedListInteractions(container, rows) {
    $$("[data-open-accepted-detail]", container).forEach((button) => {
      button.addEventListener("click", () => openAcceptedDetail(button.dataset.openAcceptedDetail));
    });

    $$("[data-open-task-workspace]", container).forEach((button) => {
      button.addEventListener("click", () => openTaskWorkspace(button.dataset.openTaskWorkspace));
    });

    $$("[data-setup-accepted]", container).forEach((button) => {
      button.addEventListener("click", () => {
        const candidateId = Number(button.dataset.setupAccepted);
        const row = rows.find((item) => Number(item.id) === candidateId);
        if (!row) return;
        prepareAcceptedSetup(row);
      });
    });

    $$("[data-manual-reject-row]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.manualRejectRow;
        if (!confirm("Reject this accepted issue and remove the PR from the accepted queue?")) return;
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/manual-reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          showToast("Accepted issue rejected.", "success");
          await loadAccepted();
          await loadDashboard();
        } catch (err) {
          showToast(`Failed to reject issue: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-filter-accepted-repo]", container).forEach((button) => {
      button.addEventListener("click", () => {
        acceptedRepoFilter = String(button.dataset.filterAcceptedRepo || "");
        acceptedPage = 0;
        if ($("#accepted-repo-filter")) {
          $("#accepted-repo-filter").value = acceptedRepoFilter;
        }
        void loadAccepted();
      });
    });

    $$("[data-reject-accepted-repo]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const repoId = button.dataset.rejectAcceptedRepo;
        const repoName = button.dataset.rejectAcceptedRepoName || "this repo";
        if (!confirm(`Reject all currently accepted items from ${repoName}?`)) return;
        button.disabled = true;
        try {
          const result = await api(`/api/accepted/repo/${repoId}/manual-reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          showToast(`Rejected ${result.rejectedCount} accepted item(s) from ${result.repoFullName || repoName}.`, "success");
          await loadAccepted();
          await loadDashboard();
        } catch (err) {
          showToast(`Failed to reject repo: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-clear-accepted-empty]", container).forEach((button) => {
      button.addEventListener("click", () => {
        acceptedSearchQuery = "";
        acceptedRepoFilter = "";
        acceptedReviewFilter = "all";
        acceptedDockerFilter = "all";
        acceptedSort = "merged_desc";
        acceptedPage = 0;
        syncAcceptedFilterControls();
        void loadAccepted();
      });
    });
  }

  function syncAcceptedFilterControls() {
    if ($("#accepted-search")) $("#accepted-search").value = acceptedSearchQuery;
    if ($("#accepted-repo-filter")) $("#accepted-repo-filter").value = acceptedRepoFilter;
    if ($("#accepted-review-filter")) $("#accepted-review-filter").value = acceptedReviewFilter;
    if ($("#accepted-docker-filter")) $("#accepted-docker-filter").value = acceptedDockerFilter;
    if ($("#accepted-sort")) $("#accepted-sort").value = acceptedSort;
  }

  async function loadAccepted() {
    const container = $("#accepted-tbody");
    stopAcceptedTestRunPolling();
    stopAcceptedCodexReviewPolling();
    activeAcceptedTestRuns.clear();
    activeAcceptedCodexReviews.clear();
    syncAcceptedFilterControls();

    try {
      const { sortBy, sortDir } = acceptedSortParams();
      const params = new URLSearchParams({
        limit: ACCEPTED_PER_PAGE,
        offset: acceptedPage * ACCEPTED_PER_PAGE,
        reviewStatus: acceptedReviewFilter,
        dockerStatus: acceptedDockerFilter,
        sortBy,
        sortDir,
      });
      if (acceptedRepoFilter) params.set("repoId", acceptedRepoFilter);
      if (acceptedSearchQuery) params.set("search", acceptedSearchQuery);

      const data = await api(`/api/accepted?${params.toString()}`);
      const rows = Array.isArray(data.rows) ? data.rows : [];
      populateAcceptedRepoFilter(data.repoOptions);
      renderAcceptedToolbarHint(rows);

      if (!rows.length) {
        renderAcceptedSummary(0, []);
        container.innerHTML = `
          <tr>
            <td colspan="11">
              <div class="empty-state">
                <div class="empty-icon">✅</div>
                <p>No accepted pull requests match the current filters.</p>
                <button type="button" class="btn btn-sm" data-clear-accepted-empty>Clear Filters</button>
              </div>
            </td>
          </tr>
        `;
        $("#accepted-pagination").innerHTML = "";
        bindAcceptedListInteractions(container, rows);
        return;
      }

      renderAcceptedSummary(data.total, rows);
      container.innerHTML = renderAcceptedTable(rows);
      bindAcceptedListInteractions(container, rows);

      rows.forEach((row) => {
        if (row.activeTestRun?.status === "running") {
          activeAcceptedTestRuns.add(String(row.id));
        }
        if (row.activeCodexReview?.status === "running") {
          activeAcceptedCodexReviews.set(String(row.id), Number(row.activeCodexReview.round || 1));
        }
      });
      if (activeAcceptedTestRuns.size) {
        ensureAcceptedTestRunPolling(container, loadAccepted);
      }
      if (activeAcceptedCodexReviews.size) {
        ensureCodexReviewPolling(container, loadAccepted);
      }

      renderPagination($("#accepted-pagination"), data.total, ACCEPTED_PER_PAGE, acceptedPage, (page) => {
        acceptedPage = page;
        void loadAccepted();
      });
    } catch (err) {
      renderAcceptedSummary(0, []);
      container.innerHTML = `<tr><td colspan="11"><div class="empty-state"><p>Error: ${err.message}</p></div></td></tr>`;
      $("#accepted-pagination").innerHTML = "";
    }
  }

  function renderAcceptedDetailPage(row) {
    const details = row.details || {};
    const codexTask = codexTaskState(details);
    const usage = manualReproUsage(details);
    const review = reviewQueueState(details);
    const manualReview = manualReviewState(details);
    const dockerTest = acceptedDockerTestState(details);
    const analysis = acceptedAnalysisState(details);
    const geminiReview = acceptedGeminiReviewState(details);
    const activeTestRun = row.activeTestRun || null;
    const activeCodexReview = row.activeCodexReview || null;
    const reasons = Array.isArray(row.rejection_reasons) ? row.rejection_reasons : [];
    const manualRepro = buildManualReproText({
      repoFullName: row.repo_full_name,
      repoUrl: row.repo_url,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      preFixSha: row.pre_fix_sha,
      details,
    });
    const issueCount = Number(row.issue_count) || (Array.isArray(row.issues) ? row.issues.length : 0);
    const lastTestCommand = Array.isArray(dockerTest.lastRun.testCommand) && dockerTest.lastRun.testCommand.length
      ? shellJoin(dockerTest.lastRun.testCommand)
      : "";
    const dockerfileReasoning = dockerTest.dockerfile.reasoningSummary
      ? `<p class="dockerfile-editor-note" data-accepted-dockerfile-reasoning="${row.id}">${esc(dockerTest.dockerfile.reasoningSummary)}</p>`
      : `<p class="dockerfile-editor-note" data-accepted-dockerfile-reasoning="${row.id}" hidden></p>`;
    const setupButtonLabel = Array.isArray(row.issues) && row.issues.length === 1 ? "Setup Issue" : "Setup Repo";

    return `
      <div class="accepted-detail-shell">
        <div class="accepted-detail-header">
          <div class="accepted-detail-main">
            <button type="button" class="btn btn-sm" data-back-to-accepted>Back To Accepted</button>
            <div class="accepted-detail-breadcrumb">
              <button type="button" class="accepted-inline-button" data-filter-accepted-repo="${row.repo_id}">${esc(row.repo_full_name)}</button>
              <span>/</span>
              <span>PR #${row.pr_number || "—"}</span>
            </div>
            <h2 class="page-title accepted-detail-title">${esc(row.pr_title || `PR #${row.pr_number || row.id}`)}</h2>
            <p class="page-subtitle">Keep the table focused on navigation and do the real review work here: notes, Dockerfile iteration, manual repro, and Codex task prep all live on this page.</p>
          </div>
          <div class="accepted-card-actions">
            <button type="button" class="btn btn-sm" data-setup-accepted="${row.id}">${setupButtonLabel}</button>
            <button type="button" class="btn btn-sm btn-info" data-deep-scan-accepted="${esc(row.repo_full_name)}">Deep Scan Repo</button>
            <button type="button" class="btn btn-sm btn-info" data-analyze-accepted-gemini="${row.id}">Analyze PR With Gemini</button>
            <button type="button" class="btn btn-sm btn-info" data-open-task-workspace="${row.id}">Open Task</button>
            <button type="button" class="btn btn-sm btn-danger" data-reject-accepted-repo="${row.repo_id}" data-reject-accepted-repo-name="${esc(row.repo_full_name)}">Reject Repo</button>
            <a href="${esc(row.pr_url || "#")}" target="_blank" class="btn btn-sm btn-info">Open PR</a>
          </div>
        </div>

        <div class="accepted-detail-metrics">
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Linked Issues</span>
            <strong>${issueCount}</strong>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Language Files</span>
            <strong>${analysis.relevantSourceFiles.length}</strong>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Language Lines</span>
            <strong>${analysis.codeLinesChanged}</strong>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Gemini</span>
            <div>${acceptedGeminiBadge(geminiReview)}</div>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Review Queue</span>
            <div>${reviewStatusBadge(review.status)}</div>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Docker Test</span>
            <div>${acceptedDockerRunBadge(activeTestRun, dockerTest)}</div>
          </div>
          <div class="accepted-detail-metric">
            <span class="accepted-detail-metric-label">Manual Repro</span>
            <div><span class="badge ${usage.used ? "badge-completed" : "badge-warn"}">${usage.used ? "Used" : "Unused"}</span></div>
          </div>
        </div>

        <div class="card accepted-detail-card">
          <div class="accepted-card-header">
            <div class="accepted-card-title">
              <span class="badge badge-accepted">Accepted</span>
              <span class="badge badge-info">Scan #${row.scan_id}</span>
              <span class="badge badge-info">${esc(acceptedDockerfileSourceLabel(dockerTest.dockerfile.source))}</span>
              ${acceptedGeminiBadge(geminiReview)}
            </div>
            <div class="accepted-card-actions">
              <button type="button" class="btn btn-sm" data-toggle-manual-repro-used="${row.id}" data-used="${usage.used ? "1" : "0"}">${usage.used ? "Mark Unused" : "Mark Used"}</button>
              <button type="button" class="btn btn-sm btn-danger" data-manual-reject="${row.id}" ${manualReview.rejected ? "disabled" : ""}>${manualReview.rejected ? "Rejected" : "Reject Issue"}</button>
            </div>
          </div>

          ${row.pr_title ? `<p class="accepted-pr-title">${esc(row.pr_title)}</p>` : ""}

          <dl class="detail-kv accepted-meta">
            <dt>Repository</dt><dd><button type="button" class="accepted-inline-button" data-filter-accepted-repo="${row.repo_id}">${esc(row.repo_full_name)}</button></dd>
            <dt>Pull Request</dt><dd>${row.pr_number ? `<a href="${esc(row.pr_url || "#")}" target="_blank" class="repo-link">#${row.pr_number}</a>` : "—"}</dd>
            <dt>Merged</dt><dd>${fmtDate(row.pr_merged_at || row.created_at)}</dd>
            <dt>Issue Count</dt><dd>${issueCount}</dd>
            <dt>Language Files</dt><dd>${analysis.relevantSourceFiles.length}</dd>
            <dt>Language Lines</dt><dd>${analysis.codeLinesChanged}</dd>
            <dt>Manual Repro</dt><dd>${usage.used ? `Used ${fmtDate(usage.usedAt)}` : "Not used yet"}</dd>
            <dt>Manual Review</dt><dd>${manualReview.rejected ? `Rejected ${fmtDate(manualReview.rejectedAt)}` : "Not manually rejected"}</dd>
          </dl>

          <div class="detail-section">
            <h4>Issues</h4>
            ${renderAcceptedIssues(row.issues, { geminiReview })}
          </div>

          ${manualReview.rejected ? `<p class="accepted-reasons">${esc(manualReview.reason || "manually rejected by user")}</p>` : ""}
          ${reasons.length ? `<p class="accepted-reasons">${esc(reasons.join(" · "))}</p>` : ""}
          ${manualRepro ? renderManualReproBlock(`accepted-detail-${row.id}`, manualRepro) : ""}
        </div>

        <div class="card">
          <div class="accepted-review-panel accepted-gemini-panel">
            <div class="accepted-review-header">
              <div class="accepted-card-title">
                <strong>Gemini PR Analysis</strong>
                ${acceptedGeminiBadge(geminiReview)}
              </div>
              <span class="accepted-review-meta">${geminiReview.analyzedAt ? `Updated ${fmtDate(geminiReview.analyzedAt)}` : "Not analyzed yet"}</span>
            </div>
            <p>${esc(geminiReview.summary || "Run Gemini analysis to have each accepted issue checked against the PR description for bug-fix / feature complexity.")}</p>
            <div class="accepted-card-actions">
              <button type="button" class="btn btn-sm btn-info" data-analyze-accepted-gemini="${row.id}">Analyze PR With Gemini</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="accepted-review-panel">
            <div class="accepted-review-header">
              <strong>Review Queue</strong>
              <span class="accepted-review-meta">${review.updatedAt ? `Updated ${fmtDate(review.updatedAt)}` : "Not reviewed yet"}</span>
            </div>
            <div class="accepted-review-controls">
              <select class="accepted-review-select" data-review-status="${row.id}">
                <option value="new" ${review.status === "new" ? "selected" : ""}>New</option>
                <option value="reviewing" ${review.status === "reviewing" ? "selected" : ""}>Reviewing</option>
                <option value="approved" ${review.status === "approved" ? "selected" : ""}>Approved</option>
                <option value="follow_up" ${review.status === "follow_up" ? "selected" : ""}>Follow Up</option>
              </select>
              <textarea class="accepted-review-notes" data-review-notes="${row.id}" placeholder="Add manual review notes...">${esc(review.notes)}</textarea>
              <div class="accepted-card-actions">
                <button type="button" class="btn btn-sm btn-info" data-save-review="${row.id}">Save Review</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="accepted-review-panel accepted-test-panel">
            <div class="accepted-review-header">
              <div class="accepted-card-title">
                <strong>Docker Test Run</strong>
                ${acceptedDockerRunBadge(activeTestRun, dockerTest)}
                <span class="badge badge-info">${esc(acceptedDockerfileSourceLabel(dockerTest.dockerfile.source))}</span>
              </div>
              <span class="accepted-review-meta">
                ${dockerTest.lastRun.finishedAt
                  ? `${dockerTest.lastRun.success ? "Passed" : "Failed"} ${fmtDate(dockerTest.lastRun.finishedAt)}`
                  : "Not run yet"}
              </span>
            </div>
            <div class="accepted-test-summary">
              <p><strong>Dockerfile:</strong> <code>${esc(dockerTest.dockerfile.path)}</code>${dockerTest.dockerfile.sha256 ? ` (${esc(dockerTest.dockerfile.sha256.slice(0, 12))})` : ""}</p>
              <p><strong>Updated:</strong> ${dockerTest.dockerfile.updatedAt ? fmtDate(dockerTest.dockerfile.updatedAt) : "Not generated yet"}</p>
              <p><strong>Last Result:</strong> ${esc(dockerTest.lastRun.summary || "No Docker test run has been recorded yet.")}</p>
              ${lastTestCommand ? `<p><strong>Last Test Command:</strong> <code>${esc(lastTestCommand)}</code></p>` : ""}
            </div>
            <div class="accepted-card-actions accepted-test-actions">
              <button type="button" class="btn btn-sm" data-toggle-accepted-dockerfile="${row.id}">Edit Dockerfile</button>
              <button type="button" class="btn btn-sm btn-info" data-generate-accepted-dockerfile="${row.id}">Gemini Test Dockerfile</button>
              <button type="button" class="btn btn-sm btn-info" data-run-accepted-tests="${row.id}">Run Tests</button>
              <button type="button" class="btn btn-sm btn-danger" data-stop-accepted-tests="${row.id}" hidden>Stop</button>
              <button type="button" class="btn btn-sm" data-fix-accepted-dockerfile="${row.id}" ${dockerTest.lastRun.finishedAt && !dockerTest.lastRun.success ? "" : "disabled"}>Fix With Gemini</button>
            </div>
            <div class="tests-unable-editor accepted-dockerfile-editor" data-accepted-dockerfile-editor="${row.id}" data-loaded="${dockerTest.dockerfile.reasoningSummary || dockerTest.dockerfile.updatedAt ? "true" : "false"}" data-dockerfile-source="${esc(dockerTest.dockerfile.source)}" data-reasoning-summary="${esc(dockerTest.dockerfile.reasoningSummary)}" hidden>
              <div class="tests-unable-editor-header">
                <div class="form-group" style="margin:0; flex:1;">
                  <label>Dockerfile Path</label>
                  <input type="text" data-accepted-dockerfile-path="${row.id}" value="${esc(dockerTest.dockerfile.path)}" placeholder="Dockerfile" spellcheck="false">
                </div>
                <button type="button" class="btn btn-sm" data-load-accepted-dockerfile="${row.id}">Reload</button>
              </div>
              <p class="dockerfile-editor-note" data-accepted-dockerfile-status="${row.id}">Load or generate the Dockerfile you want to use for the manual Docker test run.</p>
              <div data-accepted-dockerfile-choices="${row.id}"></div>
              ${dockerfileReasoning}
              <textarea class="dockerfile-editor-input" data-accepted-dockerfile-content="${row.id}" spellcheck="false" placeholder="Dockerfile content will appear here after loading.">${esc(typeof details?.acceptedTest?.dockerfile?.content === "string" ? details.acceptedTest.dockerfile.content : "")}</textarea>
            </div>
            <div class="tests-unable-rerun-panel accepted-test-run-panel" data-accepted-test-panel="${row.id}" hidden>
              <div class="tests-unable-rerun-meta">
                <span class="badge badge-running" data-accepted-test-status-badge="${row.id}">running</span>
                <span class="tests-unable-rerun-stage" data-accepted-test-stage="${row.id}">Starting Docker test run…</span>
              </div>
              <pre class="log-output log-output-compact tests-unable-live-output" data-accepted-test-output="${row.id}">Waiting for Docker output…</pre>
            </div>
            ${row.logFiles?.length ? row.logFiles.map((log) => `
              <details class="accepted-log-details">
                <summary>${esc(log.label)}</summary>
                <pre class="log-output log-output-compact">${esc(log.excerpt)}</pre>
              </details>
            `).join("") : ""}
          </div>
        </div>

        <div class="card">
          ${renderCodexTaskPanel(row, codexTask, activeCodexReview)}
        </div>
      </div>
    `;
  }

  function bindAcceptedDetailInteractions(container, row, reloadHandler) {
    attachManualReproCopyHandlers(container);
    bindCodexTaskInteractions(container, reloadHandler);

    $$("[data-back-to-accepted]", container).forEach((button) => {
      button.addEventListener("click", () => switchPage("accepted"));
    });

    $$("[data-filter-accepted-repo]", container).forEach((button) => {
      button.addEventListener("click", () => showAcceptedRepoFilter(button.dataset.filterAcceptedRepo));
    });

    $$("[data-open-task-workspace]", container).forEach((button) => {
      button.addEventListener("click", () => openTaskWorkspace(button.dataset.openTaskWorkspace));
    });

    $$("[data-deep-scan-accepted]", container).forEach((button) => {
      button.addEventListener("click", () => prepareSingleRepoDeepScan(button.dataset.deepScanAccepted));
    });

    $$("[data-analyze-accepted-gemini]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.analyzeAcceptedGemini;
        button.disabled = true;
        button.textContent = "Analyzing…";
        try {
          await api(`/api/accepted/${candidateId}/analyze-with-gemini`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          showToast("Gemini analysis saved.", "success");
          await reloadHandler();
        } catch (err) {
          showToast(`Failed to analyze PR with Gemini: ${err.message}`, "error");
          button.disabled = false;
          button.textContent = "Analyze PR With Gemini";
        }
      });
    });

    $$("[data-setup-accepted]", container).forEach((button) => {
      button.addEventListener("click", () => prepareAcceptedSetup(row));
    });

    $$("[data-reject-accepted-repo]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const repoId = button.dataset.rejectAcceptedRepo;
        const repoName = button.dataset.rejectAcceptedRepoName || row.repo_full_name || "this repo";
        if (!confirm(`Reject all currently accepted items from ${repoName}?`)) return;
        button.disabled = true;
        try {
          const result = await api(`/api/accepted/repo/${repoId}/manual-reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          showToast(`Rejected ${result.rejectedCount} accepted item(s) from ${result.repoFullName || repoName}.`, "success");
          acceptedDetailCandidateId = null;
          await loadDashboard();
          switchPage("accepted");
        } catch (err) {
          showToast(`Failed to reject repo: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-toggle-manual-repro-used]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.toggleManualReproUsed;
        const nextUsed = button.dataset.used !== "1";
        button.disabled = true;
        try {
          await api(`/api/candidates/${candidateId}/manual-repro-usage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ used: nextUsed }),
          });
          showToast(`Manual repro marked as ${nextUsed ? "used" : "unused"}.`, "success");
          await reloadHandler();
        } catch (err) {
          showToast(`Failed to update manual repro usage: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-manual-reject]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.manualReject;
        if (!confirm("Reject this accepted issue and remove the PR from the accepted queue?")) return;
        button.disabled = true;
        try {
          await api(`/api/accepted/${candidateId}/manual-reject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          showToast("Accepted issue rejected.", "success");
          acceptedDetailCandidateId = null;
          await loadDashboard();
          switchPage("accepted");
        } catch (err) {
          showToast(`Failed to reject candidate: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-save-review]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.saveReview;
        const statusInput = $(`[data-review-status="${candidateId}"]`, container);
        const notesInput = $(`[data-review-notes="${candidateId}"]`, container);
        button.disabled = true;
        try {
          await api(`/api/candidates/${candidateId}/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: statusInput?.value || "new",
              notes: notesInput?.value || "",
            }),
          });
          showToast("Review saved.", "success");
          await reloadHandler();
        } catch (err) {
          showToast(`Failed to save review: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-toggle-accepted-dockerfile]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.toggleAcceptedDockerfile;
        const editor = $(`[data-accepted-dockerfile-editor="${candidateId}"]`, container);
        if (!editor) return;
        if (editor.hidden) {
          if (editor.dataset.loaded === "true") {
            editor.hidden = false;
            button.textContent = "Hide Dockerfile";
            return;
          }
          try {
            await loadAcceptedDockerfileEditor(container, candidateId, undefined);
          } catch (err) {
            showToast(`Failed to load Dockerfile: ${err.message}`, "error");
          }
          return;
        }
        editor.hidden = true;
        button.textContent = "Edit Dockerfile";
      });
    });

    $$("[data-load-accepted-dockerfile]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.loadAcceptedDockerfile;
        const pathInput = $(`[data-accepted-dockerfile-path="${candidateId}"]`, container);
        try {
          await loadAcceptedDockerfileEditor(container, candidateId, pathInput?.value);
        } catch (err) {
          showToast(`Failed to load Dockerfile: ${err.message}`, "error");
        }
      });
    });

    $$("[data-generate-accepted-dockerfile]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.generateAcceptedDockerfile;
        const editor = $(`[data-accepted-dockerfile-editor="${candidateId}"]`, container);
        const pathInput = $(`[data-accepted-dockerfile-path="${candidateId}"]`, container);
        const contentInput = $(`[data-accepted-dockerfile-content="${candidateId}"]`, container);
        const status = $(`[data-accepted-dockerfile-status="${candidateId}"]`, container);
        const choices = $(`[data-accepted-dockerfile-choices="${candidateId}"]`, container);
        const reasoning = $(`[data-accepted-dockerfile-reasoning="${candidateId}"]`, container);
        button.disabled = true;
        button.textContent = "Generating…";
        try {
          const data = await api(`/api/accepted/${candidateId}/generate-test-dockerfile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dockerfilePath: pathInput?.value?.trim() || undefined,
            }),
          });
          if (editor) {
            editor.hidden = false;
            editor.dataset.loaded = "true";
            editor.dataset.dockerfileSource = data.source || "gemini";
            editor.dataset.reasoningSummary = data.reasoningSummary || "";
          }
          if (pathInput) pathInput.value = data.path || (pathInput?.value || "Dockerfile");
          if (contentInput) contentInput.value = data.content || "";
          if (status) {
            status.innerHTML = `Gemini generated <code>${esc(data.path || "Dockerfile")}</code> for running tests in Docker. Review it, then run tests.`;
          }
          if (choices) {
            choices.innerHTML = renderAcceptedDockerfileChoices(candidateId, data.availablePaths, data.path || pathInput?.value || "Dockerfile");
            $$(`[data-accepted-dockerfile-choice="${candidateId}"]`, container).forEach((choice) => {
              choice.addEventListener("click", async () => {
                const nextPath = choice.dataset.acceptedDockerfileChoicePath || "";
                try {
                  await loadAcceptedDockerfileEditor(container, candidateId, nextPath);
                } catch (err) {
                  showToast(`Failed to load Dockerfile: ${err.message}`, "error");
                }
              });
            });
          }
          if (reasoning) {
            reasoning.hidden = !data.reasoningSummary;
            reasoning.textContent = data.reasoningSummary || "";
          }
          const toggleButton = $(`[data-toggle-accepted-dockerfile="${candidateId}"]`, container);
          if (toggleButton) toggleButton.textContent = "Hide Dockerfile";
          const fixButton = $(`[data-fix-accepted-dockerfile="${candidateId}"]`, container);
          if (fixButton) fixButton.disabled = true;
          showToast("Gemini test Dockerfile generated.", "success");
        } catch (err) {
          showToast(`Failed to generate Dockerfile with Gemini: ${err.message}`, "error");
        } finally {
          button.disabled = false;
          button.textContent = "Gemini Test Dockerfile";
        }
      });
    });

    $$("[data-run-accepted-tests]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.runAcceptedTests;
        const editor = $(`[data-accepted-dockerfile-editor="${candidateId}"]`, container);
        const pathInput = $(`[data-accepted-dockerfile-path="${candidateId}"]`, container);
        const contentInput = $(`[data-accepted-dockerfile-content="${candidateId}"]`, container);
        const reasoning = $(`[data-accepted-dockerfile-reasoning="${candidateId}"]`, container);

        try {
          if (editor?.dataset.loaded !== "true") {
            await loadAcceptedDockerfileEditor(container, candidateId, pathInput?.value);
          }
        } catch (err) {
          showToast(`Failed to load Dockerfile before running tests: ${err.message}`, "error");
          return;
        }

        const dockerfilePath = pathInput?.value?.trim();
        const dockerfileContent = contentInput?.value || "";
        if (!dockerfilePath || !dockerfileContent.trim()) {
          showToast("Load or generate a Dockerfile before running tests.", "error");
          return;
        }

        button.disabled = true;
        button.textContent = "Running Tests…";
        try {
          const state = await api(`/api/accepted/${candidateId}/run-tests`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dockerfilePath,
              dockerfileContent,
              dockerfileSource: editor?.dataset.dockerfileSource || "manual",
              reasoningSummary: reasoning?.textContent || editor?.dataset.reasoningSummary || "",
            }),
          });
          activeAcceptedTestRuns.add(String(candidateId));
          renderAcceptedTestRunState(container, candidateId, state);
          ensureAcceptedTestRunPolling(container, reloadHandler);
          void pollAcceptedTestRunStates(container);
        } catch (err) {
          showToast(`Failed to run Docker tests: ${err.message}`, "error");
          button.disabled = false;
          button.textContent = "Run Tests";
        }
      });
    });

    $$("[data-stop-accepted-tests]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.stopAcceptedTests;
        button.disabled = true;
        try {
          const state = await api(`/api/accepted/${candidateId}/stop-test-run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          renderAcceptedTestRunState(container, candidateId, state);
        } catch (err) {
          showToast(`Failed to stop Docker tests: ${err.message}`, "error");
          button.disabled = false;
        }
      });
    });

    $$("[data-fix-accepted-dockerfile]", container).forEach((button) => {
      button.addEventListener("click", async () => {
        const candidateId = button.dataset.fixAcceptedDockerfile;
        const editor = $(`[data-accepted-dockerfile-editor="${candidateId}"]`, container);
        const pathInput = $(`[data-accepted-dockerfile-path="${candidateId}"]`, container);
        const contentInput = $(`[data-accepted-dockerfile-content="${candidateId}"]`, container);
        const output = $(`[data-accepted-test-output="${candidateId}"]`, container);
        const reasoning = $(`[data-accepted-dockerfile-reasoning="${candidateId}"]`, container);

        try {
          if (editor?.dataset.loaded !== "true") {
            await loadAcceptedDockerfileEditor(container, candidateId, pathInput?.value);
          }
        } catch (err) {
          showToast(`Failed to load Dockerfile before asking Gemini to fix it: ${err.message}`, "error");
          return;
        }

        const dockerfilePath = pathInput?.value?.trim();
        const dockerfileContent = contentInput?.value || "";
        const errorOutput = output?.textContent?.trim() || "";
        if (!dockerfilePath || !dockerfileContent.trim()) {
          showToast("Load or generate a Dockerfile before asking Gemini to fix it.", "error");
          return;
        }
        if (!errorOutput) {
          showToast("Run Docker tests first so there is an error to send to Gemini.", "error");
          return;
        }

        button.disabled = true;
        button.textContent = "Fixing…";
        try {
          const data = await api(`/api/accepted/${candidateId}/fix-test-dockerfile`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dockerfilePath,
              dockerfileContent,
              errorOutput,
            }),
          });
          if (editor) {
            editor.hidden = false;
            editor.dataset.loaded = "true";
            editor.dataset.dockerfileSource = data.source || "gemini_fix";
            editor.dataset.reasoningSummary = data.reasoningSummary || "";
          }
          if (pathInput) pathInput.value = data.path || dockerfilePath;
          if (contentInput) contentInput.value = data.content || dockerfileContent;
          if (reasoning) {
            reasoning.hidden = !data.reasoningSummary;
            reasoning.textContent = data.reasoningSummary || "";
          }
          const status = $(`[data-accepted-dockerfile-status="${candidateId}"]`, container);
          if (status) {
            status.innerHTML = `Gemini updated <code>${esc(data.path || dockerfilePath)}</code> using the last Docker test failure. Review it, then rerun.`;
          }
          const toggleButton = $(`[data-toggle-accepted-dockerfile="${candidateId}"]`, container);
          if (toggleButton) toggleButton.textContent = "Hide Dockerfile";
          showToast("Gemini updated the Dockerfile draft.", "success");
        } catch (err) {
          showToast(`Failed to fix Dockerfile with Gemini: ${err.message}`, "error");
        } finally {
          button.disabled = false;
          button.textContent = "Fix With Gemini";
        }
      });
    });

    if (row.activeTestRun) {
      renderAcceptedTestRunState(container, String(row.id), row.activeTestRun);
      if (row.activeTestRun.status === "running") {
        activeAcceptedTestRuns.add(String(row.id));
      }
    }
    if (row.activeCodexReview) {
      renderAcceptedCodexReviewState(container, String(row.id), row.activeCodexReview);
      if (row.activeCodexReview.status === "running") {
        activeAcceptedCodexReviews.set(String(row.id), Number(row.activeCodexReview.round || 1));
      }
    }
    if (activeAcceptedTestRuns.size) {
      ensureAcceptedTestRunPolling(container, reloadHandler);
    }
    if (activeAcceptedCodexReviews.size) {
      ensureCodexReviewPolling(container, reloadHandler);
    }
  }

  async function loadAcceptedDetail() {
    const container = $("#accepted-detail-page");
    stopAcceptedTestRunPolling();
    stopAcceptedCodexReviewPolling();
    activeAcceptedTestRuns.clear();
    activeAcceptedCodexReviews.clear();

    if (!acceptedDetailCandidateId) {
      container.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <div class="empty-icon">✅</div>
            <p>Select a candidate from the accepted table to open its dedicated review page.</p>
            <button type="button" class="btn btn-sm" data-back-to-accepted>Back To Accepted</button>
          </div>
        </div>
      `;
      $$("[data-back-to-accepted]", container).forEach((button) => {
        button.addEventListener("click", () => switchPage("accepted"));
      });
      return;
    }

    container.innerHTML = `<div class="card"><div class="empty-state"><p>Loading accepted candidate…</p></div></div>`;
    try {
      const row = await api(`/api/accepted/${acceptedDetailCandidateId}`);
      container.innerHTML = renderAcceptedDetailPage(row);
      bindAcceptedDetailInteractions(container, row, loadAcceptedDetail);
    } catch (err) {
      container.innerHTML = `
        <div class="card">
          <div class="empty-state">
            <p>Error: ${err.message}</p>
            <button type="button" class="btn btn-sm" data-back-to-accepted>Back To Accepted</button>
          </div>
        </div>
      `;
      $$("[data-back-to-accepted]", container).forEach((button) => {
        button.addEventListener("click", () => switchPage("accepted"));
      });
    }
  }

  let acceptedSearchTimer;
  let acceptedSearchQuery = "";
  $("#accepted-search").addEventListener("input", (event) => {
    clearTimeout(acceptedSearchTimer);
    acceptedSearchTimer = setTimeout(() => {
      acceptedSearchQuery = event.target.value.trim();
      acceptedPage = 0;
      void loadAccepted();
    }, 250);
  });

  $("#accepted-repo-filter").addEventListener("change", (event) => {
    acceptedRepoFilter = event.target.value || "";
    acceptedPage = 0;
    void loadAccepted();
  });

  $("#accepted-review-filter").addEventListener("change", (event) => {
    acceptedReviewFilter = event.target.value || "all";
    acceptedPage = 0;
    void loadAccepted();
  });

  $("#accepted-docker-filter").addEventListener("change", (event) => {
    acceptedDockerFilter = event.target.value || "all";
    acceptedPage = 0;
    void loadAccepted();
  });

  $("#accepted-sort").addEventListener("change", (event) => {
    acceptedSort = event.target.value || "merged_desc";
    acceptedPage = 0;
    void loadAccepted();
  });

  $("#accepted-clear-filters").addEventListener("click", () => {
    acceptedSearchQuery = "";
    acceptedRepoFilter = "";
    acceptedReviewFilter = "all";
    acceptedDockerFilter = "all";
    acceptedSort = "merged_desc";
    acceptedPage = 0;
    syncAcceptedFilterControls();
    void loadAccepted();
  });

  async function loadTasksPage() {
    const container = $("#task-workspace");
    stopAcceptedCodexReviewPolling();
    activeAcceptedCodexReviews.clear();
    try {
      const data = await api("/api/accepted?limit=100&offset=0&reviewStatus=all");
      if (!Array.isArray(data.rows) || !data.rows.length) {
        container.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">🧠</div><p>No accepted candidates are available for task workspaces yet.</p></div></div>`;
        return;
      }

      const rows = data.rows;
      const selected = rows.find((row) => String(row.id) === String(taskWorkspaceCandidateId)) ?? rows[0];
      taskWorkspaceCandidateId = String(selected.id);
      const selectedDetails = selected.details || {};
      const selectedTask = codexTaskState(selectedDetails);
      const activeCodexReview = selected.activeCodexReview || null;

      container.innerHTML = `
        <div class="card task-workspace-shell">
          <div class="task-selector-list">
            ${rows.map((row) => {
              const task = codexTaskState(row.details || {});
              return `
                <button
                  type="button"
                  class="task-selector-item ${String(row.id) === String(taskWorkspaceCandidateId) ? "active" : ""}"
                  data-task-select="${row.id}"
                >
                  <strong>${esc(row.repo_full_name)}</strong>
                  <span>PR #${row.pr_number || "—"}</span>
                  <span>${esc(row.pr_title || "No PR title saved")}</span>
                  <span>${task ? `Round ${task.currentRound}/${task.maxPrompts}` : "Task not started"}</span>
                </button>
              `;
            }).join("")}
          </div>
          <div class="task-workspace-main">
            <div class="card accepted-card accepted-card-task">
              <div class="accepted-card-header">
                <div class="accepted-card-summary">
                  <div class="accepted-card-summary-main">
                    <strong>${esc(selected.repo_full_name)}</strong>
                    <a href="${esc(selected.pr_url || "#")}" target="_blank" class="repo-link">PR #${selected.pr_number || "—"}</a>
                    ${codexReviewBadge(activeCodexReview, selectedTask)}
                  </div>
                  <div class="accepted-card-summary-sub">
                    <span>${esc(selected.pr_title || "No PR title saved")}</span>
                    <span>${Array.isArray(selected.issues) ? selected.issues.length : 0} issue${Array.isArray(selected.issues) && selected.issues.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <div class="accepted-card-actions">
                  <button type="button" class="btn btn-sm" data-task-open-accepted="${selected.id}">Open In Accepted</button>
                </div>
              </div>
              <div class="accepted-card-body">
                ${renderCodexTaskPanel(selected, selectedTask, activeCodexReview)}
              </div>
            </div>
          </div>
        </div>
      `;

      $$("[data-task-select]", container).forEach((button) => {
        button.addEventListener("click", () => {
          taskWorkspaceCandidateId = button.dataset.taskSelect;
          void loadTasksPage();
        });
      });
      $$("[data-task-open-accepted]", container).forEach((button) => {
        button.addEventListener("click", () => {
          openAcceptedDetail(button.dataset.taskOpenAccepted);
        });
      });
      bindCodexTaskInteractions(container, loadTasksPage);

      if (activeCodexReview) {
        renderAcceptedCodexReviewState(container, String(selected.id), activeCodexReview);
        if (activeCodexReview.status === "running") {
          activeAcceptedCodexReviews.set(String(selected.id), Number(activeCodexReview.round || selectedTask?.currentRound || 1));
        }
      }
      if (activeAcceptedCodexReviews.size) {
        ensureCodexReviewPolling(container, loadTasksPage);
      }
    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state"><p>Error: ${err.message}</p></div></div>`;
    }
  }

  /* ---- Issues ---- */
  let issuesPage = 0;
  const ISSUES_PER_PAGE = 20;

  async function loadIssues() {
    try {
      const data = await api(`/api/issues?limit=${ISSUES_PER_PAGE}&offset=${issuesPage * ISSUES_PER_PAGE}`);
      const tbody = $("#issues-tbody");

      renderTableSummary("#issues-summary", data.total, ISSUES_PER_PAGE, issuesPage);

      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">🐛</div><p>No issues yet. Run a scan to discover verified issues.</p></div></td></tr>`;
        $("#issues-pagination").innerHTML = "";
        return;
      }

      tbody.innerHTML = data.rows.map((i) => `
        <tr>
          <td><a href="${esc(i.url || '#')}" target="_blank" class="repo-link-external">${esc(i.title || `#${i.number}`)}</a></td>
          <td><a href="https://github.com/${esc(i.repo_full_name)}" target="_blank" class="repo-link-external">${esc(i.repo_full_name)}</a></td>
          <td><a href="${esc(i.pr_url || '#')}" target="_blank" class="repo-link-external">PR #${i.pr_number}</a> — ${esc(i.pr_title || "")}</td>
          <td><span class="badge ${i.state === 'open' ? 'badge-open' : 'badge-closed'}">${i.state || "—"}</span></td>
          <td><span class="link-type-label">${esc(humanLinkType(i.link_type))}</span></td>
          <td><button type="button" class="btn btn-sm" data-setup-issue="${i.id}">Setup</button></td>
        </tr>
      `).join("");

      $$("[data-setup-issue]", tbody).forEach((button) => {
        button.addEventListener("click", () => {
          const issue = data.rows.find((row) => Number(row.id) === Number(button.dataset.setupIssue));
          if (!issue) return;
          prepareIssueSetup(issue);
        });
      });

      renderPagination($("#issues-pagination"), data.total, ISSUES_PER_PAGE, issuesPage, (p) => { issuesPage = p; loadIssues(); });
    } catch (err) {
      $("#issues-tbody").innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>Error: ${err.message}</p></div></td></tr>`;
    }
  }

  /* ---- Scans ---- */
  let scansPage = 0;
  const SCANS_PER_PAGE = 20;

  async function loadScans() {
    try {
      const data = await api(`/api/scans?limit=${SCANS_PER_PAGE}&offset=${scansPage * SCANS_PER_PAGE}`);
      const tbody = $("#scans-tbody");

      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🔍</div><p>No scans yet. Start one from the New Scan page.</p></div></td></tr>`;
        $("#scans-pagination").innerHTML = "";
        return;
      }

      tbody.innerHTML = data.rows.map((s) => `
        <tr>
          <td class="text-mono">#${s.id}</td>
          <td>${statusBadge(s.status)}</td>
          <td>${fmtDate(s.started_at)}</td>
          <td>${fmtDuration(s.total_duration_ms)}</td>
          <td>${s.accepted_count}</td>
          <td>${s.rejected_count}</td>
          <td><button class="btn btn-sm btn-info" data-scan-id="${s.id}">Details</button></td>
        </tr>
      `).join("");

      renderTableSummary("#scans-summary", data.total, SCANS_PER_PAGE, scansPage);

      renderPagination($("#scans-pagination"), data.total, SCANS_PER_PAGE, scansPage, (p) => { scansPage = p; loadScans(); });

      $$("[data-scan-id]", tbody).forEach((btn) => {
        btn.addEventListener("click", () => openScanDetail(Number(btn.dataset.scanId)));
      });
    } catch (err) {
      $("#scans-tbody").innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error: ${err.message}</p></div></td></tr>`;
    }
  }

  async function openScanDetail(id) {
    const modal = $("#scan-detail-modal");
    const body = $("#scan-detail-body");
    body.innerHTML = "<p>Loading…</p>";
    modal.classList.remove("hidden");

    try {
      const data = await api(`/api/scans/${id}`);
      const cfg = safeJSON(data.config_json, {});
      const metrics = safeJSON(data.metrics_json, null);
      body.innerHTML = `
        <h2 style="margin-bottom:1rem;">Scan #${data.id} ${statusBadge(data.status)}</h2>
        <div class="detail-section">
          <h4>Summary</h4>
          <dl class="detail-kv">
            <dt>Started</dt><dd>${fmtDate(data.started_at)}</dd>
            <dt>Finished</dt><dd>${fmtDate(data.finished_at)}</dd>
            <dt>Duration</dt><dd>${fmtDuration(data.total_duration_ms)}</dd>
            <dt>Accepted</dt><dd>${data.accepted_count}</dd>
            <dt>Rejected</dt><dd>${data.rejected_count}</dd>
            <dt>Languages</dt><dd>${esc((cfg.languages || []).join(", "))}</dd>
            <dt>Scan Mode</dt><dd>${esc(cfg.scanMode || "issue-first")}</dd>
            <dt>Target Repo</dt><dd>${esc(cfg.targetRepo || "—")}</dd>
            <dt>Repo Limit</dt><dd>${cfg.repoLimit || "—"}</dd>
            <dt>Repo Concurrency</dt><dd>${cfg.repoConcurrency || "—"}</dd>
            <dt>PR Limit</dt><dd>${cfg.prLimit || "—"}</dd>
            <dt>Min Stars</dt><dd>${cfg.minStars || "—"}</dd>
            <dt>Dry Run</dt><dd>${cfg.dryRun ? "Yes" : "No"}</dd>
          </dl>
        </div>
        ${metrics?.steps?.length ? `
          <div class="detail-section">
            <h4>Performance</h4>
            ${renderScanPerformance(metrics)}
          </div>
        ` : ""}
        <div class="detail-section">
          <h4>Candidates (${data.candidates.length})</h4>
          ${data.candidates.length === 0 ? '<p>No candidates processed.</p>' : ''}
          ${data.candidates.map((c) => {
            const timings = safeJSON(c.timings_json, []);
            const details = safeJSON(c.details_json, {});
            const reasons = safeJSON(c.rejection_reasons, []);
            const manualRepro = buildManualReproText({
              repoFullName: c.repo_full_name,
              repoUrl: c.repo_url,
              prNumber: c.pr_number,
              prUrl: c.pr_url,
              preFixSha: c.pre_fix_sha,
              details,
            });
            return `
              <div style="margin-bottom:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:8px;">
                <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.3rem;">
                  <strong>${esc(c.repo_full_name)}</strong>
                  ${c.accepted ? '<span class="badge badge-accepted">Accepted</span>' : '<span class="badge badge-rejected">Rejected</span>'}
                  ${c.tests_unable_to_run ? '<span class="badge badge-warn">⚠️ Tests Unable</span>' : ''}
                  <span style="color:var(--text-muted); font-size:0.75rem;">⭐ ${c.repo_stars}</span>
                  ${c.pr_number ? `<a href="${esc(c.pr_url || "#")}" target="_blank" class="repo-link">PR #${c.pr_number}</a>` : ""}
                </div>
                ${c.pre_fix_sha ? `<p style="font-size:0.75rem; color:var(--text-muted);">SHA: <code>${esc(c.pre_fix_sha.slice(0, 12))}</code></p>` : ''}
                ${c.tests_unable_to_run_reason ? `<p style="font-size:0.78rem; color:var(--accent-orange);">${esc(c.tests_unable_to_run_reason)}</p>` : ''}
                ${reasons.length ? `<p style="font-size:0.78rem; color:var(--accent-red);">${esc(reasons.join(" · "))}</p>` : ''}
                ${timings.length ? renderTimings(timings) : ''}
                ${details.testPlan ? `<p style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.3rem;">Plan: ${esc(details.testPlan.reasoningSummary || '—')}</p>` : ''}
                ${manualRepro ? renderManualReproBlock(`scan-candidate-${c.id}`, manualRepro) : ""}
              </div>
            `;
          }).join("")}
        </div>
      `;
      attachManualReproCopyHandlers(body);
    } catch (err) {
      body.innerHTML = `<p>Error: ${err.message}</p>`;
    }
  }

  $("#scan-modal-close").addEventListener("click", () => $("#scan-detail-modal").classList.add("hidden"));
  $("#scan-detail-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden"); });
  let testsUnableRerunPoller = null;
  const activeTestsUnableReruns = new Set();

  function preferredDockerfilePath(row) {
    return [
      row?.details?.rerun?.dockerfileOverride?.path,
      row?.details?.rerun?.testPlan?.dockerfilePath,
      row?.details?.testPlan?.dockerfilePath,
    ].find((value) => typeof value === "string" && value.trim()) || "Dockerfile";
  }

  function renderDockerfileChoices(candidateId, paths, selectedPath) {
    const uniquePaths = [...new Set((Array.isArray(paths) ? paths : []).filter((path) => typeof path === "string" && path.trim()))];
    if (!uniquePaths.length) return "";
    return `
      <div class="dockerfile-choice-list">
        ${uniquePaths.map((path) => `
          <button
            type="button"
            class="dockerfile-choice ${path === selectedPath ? "active" : ""}"
            data-dockerfile-choice="${candidateId}"
            data-dockerfile-choice-path="${esc(path)}"
          >${esc(path)}</button>
        `).join("")}
      </div>
    `;
  }

  function attachDockerfileChoiceHandlers(body, candidateId) {
    $$(`[data-dockerfile-choice="${candidateId}"]`, body).forEach((button) => {
      button.addEventListener("click", async () => {
        const pathInput = $(`[data-dockerfile-path="${candidateId}"]`, body);
        const nextPath = button.dataset.dockerfileChoicePath || "";
        if (pathInput) {
          pathInput.value = nextPath;
        }
        try {
          await loadTestsUnableDockerfileEditor(body, candidateId, nextPath);
        } catch (err) {
          alert("Failed to load Dockerfile: " + err.message);
        }
      });
    });
  }

  async function loadTestsUnableDockerfileEditor(body, candidateId, requestedPath) {
    const editor = $(`[data-dockerfile-editor="${candidateId}"]`, body);
    const toggleButton = $(`[data-toggle-dockerfile="${candidateId}"]`, body);
    const reloadButton = $(`[data-load-dockerfile="${candidateId}"]`, body);
    const pathInput = $(`[data-dockerfile-path="${candidateId}"]`, body);
    const contentInput = $(`[data-dockerfile-content="${candidateId}"]`, body);
    const status = $(`[data-dockerfile-status="${candidateId}"]`, body);
    const choices = $(`[data-dockerfile-choices="${candidateId}"]`, body);
    if (!editor || !pathInput || !contentInput || !status || !choices) {
      throw new Error("dockerfile editor controls are missing");
    }

    const query = new URLSearchParams();
    const path = typeof requestedPath === "string" && requestedPath.trim()
      ? requestedPath.trim()
      : (pathInput.value.trim() || "");
    if (path) {
      query.set("path", path);
    }

    editor.hidden = false;
    editor.dataset.loaded = "loading";
    status.textContent = "Loading Dockerfile from the stored pre-fix SHA…";
    if (toggleButton) {
      toggleButton.disabled = true;
      toggleButton.textContent = "Loading Dockerfile…";
    }
    if (reloadButton) {
      reloadButton.disabled = true;
    }

    try {
      const data = await api(
        query.toString()
          ? `/api/tests-unable/${candidateId}/dockerfile?${query.toString()}`
          : `/api/tests-unable/${candidateId}/dockerfile`,
      );
      const selectedPath = data.path || "Dockerfile";
      pathInput.value = selectedPath;
      contentInput.value = data.content || "";
      editor.dataset.loaded = "true";
      status.innerHTML = data.exists
        ? `Loaded <code>${esc(selectedPath)}</code> from the stored pre-fix SHA. Edit it below, then rerun.`
        : `No Dockerfile existed at <code>${esc(selectedPath)}</code> in the stored pre-fix SHA. You can create one here for this rerun.`;
      choices.innerHTML = renderDockerfileChoices(candidateId, data.availablePaths, selectedPath);
      attachDockerfileChoiceHandlers(body, candidateId);
      if (toggleButton) {
        toggleButton.textContent = "Hide Dockerfile";
      }
    } catch (err) {
      editor.dataset.loaded = "error";
      status.textContent = `Unable to load Dockerfile: ${err.message}`;
      choices.innerHTML = "";
      if (toggleButton) {
        toggleButton.textContent = "Edit Dockerfile";
      }
      throw err;
    } finally {
      if (toggleButton) {
        toggleButton.disabled = false;
      }
      if (reloadButton) {
        reloadButton.disabled = false;
      }
    }
  }

  function stopTestsUnableRerunPolling() {
    if (testsUnableRerunPoller) {
      clearInterval(testsUnableRerunPoller);
      testsUnableRerunPoller = null;
    }
  }

  function renderTestsUnableRerunState(body, candidateId, state) {
    const panel = $(`[data-rerun-panel="${candidateId}"]`, body);
    const badge = $(`[data-rerun-status-badge="${candidateId}"]`, body);
    const stage = $(`[data-rerun-stage="${candidateId}"]`, body);
    const output = $(`[data-rerun-output="${candidateId}"]`, body);
    const stopButton = $(`[data-stop-rerun="${candidateId}"]`, body);
    const rerunButton = $(`[data-rerun-tests-unable="${candidateId}"]`, body);
    if (!panel || !badge || !stage || !output || !stopButton || !rerunButton) return;

    const status = state?.status || "idle";
    const isRunning = status === "running";
    panel.hidden = status === "idle";
    badge.className = `badge ${badgeClassForStatus(status)}`;
    badge.textContent = status;
    stage.textContent = state?.stage || (isRunning ? "Starting rerun…" : "Idle");
    output.textContent = state?.liveOutput || (Array.isArray(state?.logs) ? state.logs.join("\n") : "Waiting for Docker output…");
    output.scrollTop = output.scrollHeight;
    stopButton.hidden = !isRunning;
    stopButton.disabled = !isRunning;
    rerunButton.disabled = isRunning;
    rerunButton.textContent = isRunning ? "Rerunning…" : "Rerun";
  }

  async function pollTestsUnableRerunStates(body) {
    const candidateIds = [...activeTestsUnableReruns];
    if (!candidateIds.length) {
      stopTestsUnableRerunPolling();
      return;
    }

    try {
      const states = await Promise.all(candidateIds.map(async (candidateId) => {
        try {
          return await api(`/api/tests-unable/${candidateId}/rerun-status`);
        } catch (err) {
          return { candidateId, status: "failed", stage: err.message, liveOutput: "", logs: [], error: err.message };
        }
      }));

      let shouldReload = false;
      for (const state of states) {
        renderTestsUnableRerunState(body, String(state.candidateId), state);
        if (state.status === "running") continue;
        activeTestsUnableReruns.delete(String(state.candidateId));
        if (state.status === "completed") {
          shouldReload = true;
        }
      }

      if (shouldReload) {
        await loadDashboard();
        await openTestsUnableModal();
        return;
      }

      if (!activeTestsUnableReruns.size) {
        stopTestsUnableRerunPolling();
      }
    } catch {
      /* keep polling on transient failures */
    }
  }

  function ensureTestsUnableRerunPolling(body) {
    if (!activeTestsUnableReruns.size || testsUnableRerunPoller) return;
    testsUnableRerunPoller = setInterval(() => {
      void pollTestsUnableRerunStates(body);
    }, 1500);
  }

  async function openTestsUnableModal() {
    const modal = $("#tests-unable-modal");
    const body = $("#tests-unable-body");
    stopTestsUnableRerunPolling();
    activeTestsUnableReruns.clear();
    body.innerHTML = "<p>Loading…</p>";
    modal.classList.remove("hidden");

    try {
      const data = await api("/api/tests-unable?limit=50");
      body.innerHTML = `
        <h2 style="margin-bottom:1rem;">Tests Unable (${data.total})</h2>
        ${data.rows.length === 0 ? "<p>No tests-unable candidates found.</p>" : data.rows.map((row) => `
          <div class="tests-unable-card">
            <div class="tests-unable-card-header">
              <div class="tests-unable-card-title">
                <strong>${esc(row.repo_full_name)}</strong>
                <span class="badge badge-warn">Tests Unable</span>
                <span style="font-size:0.78rem; color:var(--text-muted);">Scan #${row.scan_id}</span>
                ${row.pr_number ? `<a href="${esc(row.pr_url || "#")}" target="_blank" class="repo-link">PR #${row.pr_number}</a>` : ""}
              </div>
              <div class="tests-unable-card-actions">
                <button type="button" class="btn btn-sm btn-info" data-copy-manual-repro="tests-unable-${row.id}">Copy Repro</button>
                <button type="button" class="btn btn-sm" data-toggle-dockerfile="${row.id}">Edit Dockerfile</button>
                <button type="button" class="btn btn-sm btn-info" data-rerun-tests-unable="${row.id}">Rerun</button>
                <button type="button" class="btn btn-sm btn-danger" data-stop-rerun="${row.id}" hidden>Stop</button>
              </div>
            </div>
            ${row.pr_title ? `<p style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:0.35rem;">${esc(row.pr_title)}</p>` : ""}
            <p style="font-size:0.82rem; color:var(--accent-orange); margin-bottom:0.35rem;">${esc(row.tests_unable_to_run_reason || "Tests could not be executed")}</p>
            ${Array.isArray(row.rejection_reasons) && row.rejection_reasons.length ? `<p style="font-size:0.78rem; color:var(--accent-red); margin-bottom:0.5rem;">${esc(row.rejection_reasons.join(" · "))}</p>` : ""}
            ${row.details?.rerun?.dockerfileOverride ? `
              <p style="font-size:0.78rem; color:var(--accent-cyan); margin-bottom:0.5rem;">
                Rerun Dockerfile: <code>${esc(row.details.rerun.dockerfileOverride.path || "Dockerfile")}</code>
                (${esc((row.details.rerun.dockerfileOverride.sha256 || "").slice(0, 12)) || "no hash"})
              </p>
            ` : ""}
            ${Array.isArray(row.details?.rerun?.execution?.notes) && row.details.rerun.execution.notes.length ? `
              <p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem;">
                ${esc(row.details.rerun.execution.notes.join(" · "))}
              </p>
            ` : ""}
            ${renderManualReproBlock(`tests-unable-${row.id}`, buildManualReproText({
              repoFullName: row.repo_full_name,
              repoUrl: row.repo_url,
              prNumber: row.pr_number,
              prUrl: row.pr_url,
              preFixSha: row.pre_fix_sha,
              details: row.details || {},
            }))}
            <div class="tests-unable-editor" data-dockerfile-editor="${row.id}" data-loaded="false" hidden>
              <div class="tests-unable-editor-header">
                <div class="form-group" style="margin:0; flex:1;">
                  <label>Dockerfile Path</label>
                  <input type="text" data-dockerfile-path="${row.id}" value="${esc(preferredDockerfilePath(row))}" placeholder="Dockerfile" spellcheck="false">
                </div>
                <button type="button" class="btn btn-sm" data-load-dockerfile="${row.id}">Reload From SHA</button>
              </div>
              <p class="dockerfile-editor-note" data-dockerfile-status="${row.id}">Load the Dockerfile from the stored pre-fix SHA, edit it here, then rerun.</p>
              <div data-dockerfile-choices="${row.id}"></div>
              <textarea class="dockerfile-editor-input" data-dockerfile-content="${row.id}" spellcheck="false" placeholder="Dockerfile content will appear here after loading."></textarea>
            </div>
            <div class="tests-unable-rerun-panel" data-rerun-panel="${row.id}" hidden>
              <div class="tests-unable-rerun-meta">
                <span class="badge badge-running" data-rerun-status-badge="${row.id}">running</span>
                <span class="tests-unable-rerun-stage" data-rerun-stage="${row.id}">Starting rerun…</span>
              </div>
              <pre class="log-output log-output-compact tests-unable-live-output" data-rerun-output="${row.id}">Waiting for Docker output…</pre>
            </div>
            ${row.logFiles?.length ? row.logFiles.map((log) => `
              <details style="margin-top:0.5rem;">
                <summary style="cursor:pointer; color:var(--accent-blue);">${esc(log.label)}</summary>
                <pre class="log-output log-output-compact">${esc(log.excerpt)}</pre>
              </details>
            `).join("") : '<p style="font-size:0.78rem; color:var(--text-muted);">No execution log is available for this candidate.</p>'}
          </div>
        `).join("")}
      `;
      attachManualReproCopyHandlers(body);

      $$("[data-toggle-dockerfile]", body).forEach((button) => {
        button.addEventListener("click", async () => {
          const candidateId = button.dataset.toggleDockerfile;
          const editor = $(`[data-dockerfile-editor="${candidateId}"]`, body);
          if (!editor) return;
          if (editor.hidden) {
            if (editor.dataset.loaded === "true") {
              editor.hidden = false;
              button.textContent = "Hide Dockerfile";
              return;
            }
            try {
              await loadTestsUnableDockerfileEditor(body, candidateId, undefined);
            } catch (err) {
              alert("Failed to load Dockerfile: " + err.message);
            }
            return;
          }

          editor.hidden = true;
          button.textContent = "Edit Dockerfile";
        });
      });

      $$("[data-load-dockerfile]", body).forEach((button) => {
        button.addEventListener("click", async () => {
          const candidateId = button.dataset.loadDockerfile;
          const pathInput = $(`[data-dockerfile-path="${candidateId}"]`, body);
          try {
            await loadTestsUnableDockerfileEditor(body, candidateId, pathInput?.value);
          } catch (err) {
            alert("Failed to load Dockerfile: " + err.message);
          }
        });
      });

      $$("[data-rerun-tests-unable]", body).forEach((button) => {
        button.addEventListener("click", async () => {
          const candidateId = button.dataset.rerunTestsUnable;
          const editor = $(`[data-dockerfile-editor="${candidateId}"]`, body);
          const payload = {};
          if (editor?.dataset.loaded === "true") {
            const pathInput = $(`[data-dockerfile-path="${candidateId}"]`, body);
            const contentInput = $(`[data-dockerfile-content="${candidateId}"]`, body);
            const dockerfilePath = pathInput?.value?.trim();
            if (!dockerfilePath) {
              alert("Enter a Dockerfile path before rerunning with an override.");
              return;
            }
            payload.dockerfilePath = dockerfilePath;
            payload.dockerfileContent = contentInput?.value || "";
          }

          button.disabled = true;
          button.textContent = editor?.dataset.loaded === "true" ? "Rerunning With Dockerfile…" : "Rerunning…";
          try {
            const state = await api(`/api/tests-unable/${candidateId}/rerun`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            activeTestsUnableReruns.add(String(candidateId));
            renderTestsUnableRerunState(body, candidateId, state);
            ensureTestsUnableRerunPolling(body);
            void pollTestsUnableRerunStates(body);
          } catch (err) {
            alert("Failed to rerun candidate: " + err.message);
            button.disabled = false;
            button.textContent = "Rerun";
          }
        });
      });

      $$("[data-stop-rerun]", body).forEach((button) => {
        button.addEventListener("click", async () => {
          const candidateId = button.dataset.stopRerun;
          button.disabled = true;
          try {
            const state = await api(`/api/tests-unable/${candidateId}/stop`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
            renderTestsUnableRerunState(body, candidateId, state);
          } catch (err) {
            alert("Failed to stop rerun: " + err.message);
            button.disabled = false;
          }
        });
      });

      data.rows.forEach((row) => {
        if (!row.activeRerun) return;
        renderTestsUnableRerunState(body, String(row.id), row.activeRerun);
        if (row.activeRerun.status === "running") {
          activeTestsUnableReruns.add(String(row.id));
        }
      });
      if (activeTestsUnableReruns.size) {
        ensureTestsUnableRerunPolling(body);
        void pollTestsUnableRerunStates(body);
      }
    } catch (err) {
      body.innerHTML = `<p>Error: ${err.message}</p>`;
    }
  }

  $("#tests-unable-close").addEventListener("click", () => {
    stopTestsUnableRerunPolling();
    $("#tests-unable-modal").classList.add("hidden");
  });
  $("#tests-unable-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      stopTestsUnableRerunPolling();
      e.currentTarget.classList.add("hidden");
    }
  });

  /* ---- New Scan ---- */
  let logPolling = null;

  $("#scan-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#scan-submit");
    btn.disabled = true;
    btn.textContent = "Starting…";

    const languages = $$("input[name='lang']:checked").map((cb) => cb.value);
    const body = {
      languages,
      repoLimit: Number($("#f-repo-limit").value) || 10,
      repoConcurrency: Math.max(1, Number($("#f-repo-concurrency").value) || 1),
      prLimit: Number($("#f-pr-limit").value) || 10,
      minStars: Number($("#f-min-stars").value) || 200,
      mergedAfter: $("#f-merged-after").value || undefined,
      scanMode: $("#f-scan-mode").value || "issue-first",
      targetRepo: $("#f-target-repo").value.trim() || undefined,
      dryRun: $("#f-dry-run").checked,
    };

    try {
      await api("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      renderScanState({
        running: true,
        status: "running",
        logs: [],
        currentStage: "Starting scan...",
        metrics: null,
      });
      startLogPolling();
    } catch (err) {
      alert("Failed to start scan: " + err.message);
      btn.disabled = false;
      btn.textContent = "🚀 Start Scan";
    }
  });

  function showScanLogCard() {
    $("#scan-log-card").style.display = "block";
  }

  function setScanBadge(status, running) {
    const badge = $("#scan-running-badge");
    const resolvedStatus = status || (running ? "running" : "completed");
    badge.style.display = "inline-flex";
    badge.className = `badge ${badgeClassForStatus(resolvedStatus)}${running ? " badge-pulse" : ""}`;
    badge.textContent = resolvedStatus;
  }

  function renderScanState(data) {
    showScanLogCard();

    const out = $("#scan-log-output");
    const logs = Array.isArray(data.logs) ? data.logs : [];
    out.textContent = logs.join("\n") || "Waiting for scan output...\n";
    out.scrollTop = out.scrollHeight;

    $("#scan-status-text").textContent = data.currentStage || (data.running ? "Starting scan..." : "No recent scan activity.");
    setScanBadge(data.status, Boolean(data.running));

    const liveSummaryBox = $("#scan-live-summary");
    const summary = data.summary && typeof data.summary === "object" ? data.summary : null;
    const hasSummary = Boolean(summary) && (
      data.running
      || Number(summary.totalReposDiscovered) > 0
      || Number(summary.totalReposProcessed) > 0
      || Number(summary.totalPullRequestsAnalyzed) > 0
      || Number(summary.totalCandidatesRecorded) > 0
    );
    liveSummaryBox.style.display = hasSummary ? "block" : "none";
    liveSummaryBox.innerHTML = hasSummary ? renderLiveScanSummary(summary) : "";

    const metricsBox = $("#scan-performance-summary");
    const hasMetrics = data.metrics && Array.isArray(data.metrics.steps) && data.metrics.steps.length > 0;
    metricsBox.style.display = hasMetrics ? "block" : "none";
    metricsBox.innerHTML = hasMetrics ? renderScanPerformance(data.metrics) : "";
  }

  function stopLogPolling() {
    if (logPolling) clearInterval(logPolling);
    logPolling = null;
  }

  async function refreshScanState() {
    try {
      const data = await api("/api/scans/active/logs");
      if (data.running || (Array.isArray(data.logs) && data.logs.length) || (data.metrics && data.metrics.steps?.length)) {
        renderScanState(data);
      }

      if (data.running && document.querySelector("#page-repos.page.active")) {
        void loadRepos($("#repo-search").value);
      }

      if (!data.running) {
        stopLogPolling();
        const btn = $("#scan-submit");
        btn.disabled = false;
        btn.textContent = "🚀 Start Scan";
        loadDashboard();
      }
    } catch { /* ignore polling errors */ }
  }

  function startLogPolling() {
    stopLogPolling();
    void refreshScanState();
    logPolling = setInterval(() => {
      void refreshScanState();
    }, 2000);
  }

  // Check if a scan is already running on load
  async function checkActiveScan() {
    try {
      const data = await api("/api/scans/active/logs");
      if (data.running || (Array.isArray(data.logs) && data.logs.length) || (data.metrics && data.metrics.steps?.length)) {
        renderScanState(data);
      }
      if (data.running) startLogPolling();
    } catch { /* ignore */ }
  }

  /* ---- Pagination helper ---- */
  function renderPagination(container, total, perPage, current, onPageChange) {
    const totalPages = Math.ceil(total / perPage);
    if (totalPages <= 1) { container.innerHTML = ""; return; }
    let html = "";
    if (current > 0) html += `<button class="btn btn-sm" data-p="${current - 1}">← Prev</button>`;
    html += `<span style="font-size:0.82rem; color:var(--text-secondary);">Page ${current + 1} of ${totalPages}</span>`;
    if (current < totalPages - 1) html += `<button class="btn btn-sm" data-p="${current + 1}">Next →</button>`;
    container.innerHTML = html;
    $$("[data-p]", container).forEach((btn) => {
      btn.addEventListener("click", () => onPageChange(Number(btn.dataset.p)));
    });
  }

  /* ---- Timing rendering ---- */
  function renderTimings(timings) {
    return `<div class="timing-bar">${timings.map((t) =>
      `<span class="timing-chip ${t.status}" title="${esc(t.detail || '')}"><strong>${t.step}</strong> ${fmtDuration(t.durationMs)}</span>`
    ).join("")}</div>`;
  }

  function renderScanPerformance(metrics) {
    const steps = Array.isArray(metrics?.steps) ? metrics.steps : [];
    const statCard = (label, value) => `
      <div class="scan-performance-stat">
        <span class="scan-performance-label">${label}</span>
        <span class="scan-performance-value">${value}</span>
      </div>
    `;

    return `
      <div class="scan-performance-grid">
        ${statCard("Repos Found", metrics.totalReposDiscovered ?? 0)}
        ${statCard("Repos Processed", metrics.totalReposProcessed ?? 0)}
        ${statCard("PRs Analyzed", metrics.totalPullRequestsAnalyzed ?? 0)}
        ${statCard("Candidates", metrics.totalCandidatesRecorded ?? 0)}
      </div>
      ${steps.length ? `<div class="table-wrap"><table class="scan-performance-table">
        <thead>
          <tr><th>Step</th><th>Runs</th><th>Total</th><th>Avg</th><th>Max</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${steps.map((step) => `
            <tr>
              <td class="step-name">${esc(step.step)}</td>
              <td>${step.count}</td>
              <td>${fmtDuration(step.totalDurationMs)}</td>
              <td>${fmtDuration(step.averageDurationMs)}</td>
              <td>${fmtDuration(step.maxDurationMs)}</td>
              <td>${step.okCount} ok / ${step.failedCount} fail / ${step.skippedCount} skip</td>
            </tr>
          `).join("")}
        </tbody>
      </table></div>` : "<p>No step timings recorded.</p>"}
    `;
  }

  function renderLiveScanSummary(summary) {
    const statCard = (label, value) => `
      <div class="scan-performance-stat">
        <span class="scan-performance-label">${label}</span>
        <span class="scan-performance-value">${value}</span>
      </div>
    `;
    const scanned = typeof summary?.currentRepoPullRequestsScanned === "number" ? summary.currentRepoPullRequestsScanned : null;
    const total = typeof summary?.currentRepoPullRequestsTotal === "number" ? summary.currentRepoPullRequestsTotal : null;
    const passed = typeof summary?.currentRepoBasicFilterPasses === "number" ? summary.currentRepoBasicFilterPasses : null;
    const limit = typeof summary?.currentRepoPrLimit === "number" ? summary.currentRepoPrLimit : null;

    return `
      <div class="scan-performance-grid">
        ${statCard("Repos Found", summary?.totalReposDiscovered ?? 0)}
        ${statCard("Repos Processed", summary?.totalReposProcessed ?? 0)}
        ${statCard("PRs Scanned", summary?.totalPullRequestsAnalyzed ?? 0)}
        ${statCard("Candidates", summary?.totalCandidatesRecorded ?? 0)}
        ${statCard("Accepted", summary?.acceptedCount ?? 0)}
        ${statCard("Rejected", summary?.rejectedCount ?? 0)}
      </div>
      ${summary?.currentRepoFullName ? `<p class="scan-live-meta"><strong>Current repo:</strong> ${esc(summary.currentRepoFullName)}</p>` : ""}
      ${scanned !== null || total !== null || passed !== null ? `<p class="scan-live-meta"><strong>Repo progress:</strong> ${total !== null ? `${scanned ?? 0}/${total} PRs walked` : `${scanned ?? 0} PRs walked`}, ${passed ?? 0} passed basic filter${limit !== null ? `, limit ${limit}` : ""}</p>` : ""}
    `;
  }

  /* ---- Utility ---- */
  function esc(s) {
    if (!s) return "";
    const div = document.createElement("div");
    div.textContent = String(s);
    return div.innerHTML;
  }

  function safeJSON(s, fallback) {
    if (!s) return fallback;
    if (typeof s === "object") return s;
    try { return JSON.parse(s); } catch { return fallback; }
  }

  /* ---- Toast notification system ---- */
  function showToast(message, type = 'info', durationMs = 4000) {
    const container = $('#toast-container');
    if (!container) return;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${esc(message)}</span>
      <button class="toast-dismiss" aria-label="Dismiss">&times;</button>
    `;
    container.appendChild(toast);
    const dismiss = () => {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    };
    toast.querySelector('.toast-dismiss').addEventListener('click', dismiss);
    if (durationMs > 0) setTimeout(dismiss, durationMs);
  }

  /* ---- Link type humanizer ---- */
  function humanLinkType(linkType) {
    const map = {
      github_linked: 'GitHub Linked',
      body_reference: 'Body Reference',
      commit_reference: 'Commit Reference',
      timeline_reference: 'Timeline Reference',
      closing_reference: 'Closing Reference',
    };
    return map[linkType] || (linkType || '—').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /* ---- Table summary helper ---- */
  function renderTableSummary(containerId, total, perPage, page) {
    const el = $(containerId);
    if (!el) return;
    if (!total) { el.innerHTML = ''; return; }
    const start = page * perPage + 1;
    const end = Math.min((page + 1) * perPage, total);
    el.innerHTML = `<span class="summary-left">Showing <strong>${start}–${end}</strong> of <strong>${total}</strong></span>`;
  }

  /* ---- Page loader ---- */
  function loadPage(page) {
    switch (page) {
      case "dashboard": loadDashboard(); break;
      case "repos": loadRepos(); break;
      case "setup": loadSetup(); break;
      case "accepted": loadAccepted(); break;
      case "accepted-detail": loadAcceptedDetail(); break;
      case "tasks": loadTasksPage(); break;
      case "issues": loadIssues(); break;
      case "scans": loadScans(); break;
      case "new-scan": checkActiveScan(); break;
    }
  }

  /* ---- Init ---- */
  bindDashboardActions($("#page-dashboard"));
  loadDashboard();
})();
