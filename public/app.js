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
    return { running: "badge-running", completed: "badge-completed", failed: "badge-failed" }[status] || "badge-warn";
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
  const pages = ["dashboard", "repos", "accepted", "issues", "scans", "new-scan"];
  let currentPage = "dashboard";
  const selectedRepoIds = new Set();
  let visibleRepoIds = [];

  function switchPage(page) {
    currentPage = page;
    pages.forEach((p) => {
      const el = $(`#page-${p}`);
      const nav = $(`#nav-${p.replace("-", "-")}`);
      if (!el) return;
      el.classList.toggle("active", p === page);
      if (nav) nav.classList.toggle("active", p === page);
    });
    // Fix nav link active states for the dashed name
    $$(".nav-links a").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === page);
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

  async function loadRepos(search) {
    try {
      const params = new URLSearchParams({ limit: REPOS_PER_PAGE, offset: reposPage * REPOS_PER_PAGE });
      if (search) params.set("search", search);
      const data = await api(`/api/repos?${params}`);
      const tbody = $("#repos-tbody");
      visibleRepoIds = data.rows.map((row) => Number(row.id));

      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📦</div><p>No repos found. Start a scan to mine repositories.</p></div></td></tr>`;
        $("#repos-pagination").innerHTML = "";
        updateRepoBulkDeleteUI([]);
        return;
      }

      tbody.innerHTML = data.rows.map((r) => `
        <tr>
          <td><input type="checkbox" data-repo-select="${r.id}" ${selectedRepoIds.has(Number(r.id)) ? "checked" : ""} aria-label="Select ${esc(r.full_name)}"></td>
          <td><a class="repo-link" data-repo-id="${r.id}">${esc(r.full_name)}</a></td>
          <td>⭐ ${r.stars}</td>
          <td>${esc(r.primary_language || "—")}</td>
          <td>${r.pr_count}</td>
          <td>${r.issue_count}</td>
          <td>${r.accepted_count > 0 ? '<span class="badge badge-accepted">✅ Accepted</span>' : '<span class="badge badge-rejected">❌ Rejected</span>'}</td>
          <td>
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

      // Delete
      $$("[data-delete-repo]", tbody).forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this repo from the database? It will be eligible for re-scanning.")) return;
          selectedRepoIds.delete(Number(btn.dataset.deleteRepo));
          await api(`/api/repos/${btn.dataset.deleteRepo}`, { method: "DELETE" });
          loadRepos($("#repo-search").value);
          loadDashboard();
        });
      });

      $$("[data-deep-scan-repo]", tbody).forEach((btn) => {
        btn.addEventListener("click", () => {
          prepareSingleRepoDeepScan(btn.dataset.deepScanRepo);
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
          <button type="button" class="btn btn-info" data-modal-deep-scan="${esc(data.full_name)}">Deep Scan This Repo</button>
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
    try {
      for (const repoId of ids) {
        await api(`/api/repos/${repoId}`, { method: "DELETE" });
        selectedRepoIds.delete(repoId);
      }
      await loadRepos($("#repo-search").value);
      await loadDashboard();
    } catch (err) {
      alert("Failed to delete selected repos: " + err.message);
      updateRepoBulkDeleteUI(visibleRepoIds.map((id) => ({ id })));
    }
  });

  /* ---- Accepted ---- */
  let acceptedPage = 0;
  const ACCEPTED_PER_PAGE = 10;
  let acceptedReviewFilter = "all";
  let acceptedTestRunPoller = null;
  const activeAcceptedTestRuns = new Set();
  const expandedAcceptedRows = new Set();

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
        await loadAccepted();
        return;
      }

      if (!activeAcceptedTestRuns.size) {
        stopAcceptedTestRunPolling();
      }
    } catch {
      /* keep polling on transient failures */
    }
  }

  function ensureAcceptedTestRunPolling(container) {
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

  function renderAcceptedIssues(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return `<p class="accepted-empty">No verified issues saved for this PR.</p>`;
    }
    return `
      <div class="accepted-issue-list">
        ${issues.map((issue) => `
          <a href="${esc(issue.url || "#")}" target="_blank" class="accepted-issue-item">
            <strong>${esc(issue.issue_repo_full_name || `${issue.owner}/${issue.repo}`)}</strong>
            <span>#${issue.number}</span>
            <span>${esc(issue.title || "Untitled issue")}</span>
          </a>
        `).join("")}
      </div>
    `;
  }

  async function loadAccepted() {
    const container = $("#accepted-list");
    stopAcceptedTestRunPolling();
    activeAcceptedTestRuns.clear();
    try {
      const params = new URLSearchParams({
        limit: ACCEPTED_PER_PAGE,
        offset: acceptedPage * ACCEPTED_PER_PAGE,
        reviewStatus: acceptedReviewFilter,
      });
      const data = await api(`/api/accepted?${params.toString()}`);
      if (!data.rows.length) {
        container.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">✅</div><p>No accepted pull requests yet.</p></div></div>`;
        $("#accepted-pagination").innerHTML = "";
        return;
      }

      const reviewOrder = { new: 0, reviewing: 1, follow_up: 2, approved: 3 };
      const rows = [...data.rows].sort((left, right) => {
        const leftReview = reviewQueueState(left.details);
        const rightReview = reviewQueueState(right.details);
        return (reviewOrder[leftReview.status] ?? 0) - (reviewOrder[rightReview.status] ?? 0);
      });

      container.innerHTML = rows.map((row) => {
        const details = row.details || {};
        const usage = manualReproUsage(details);
        const review = reviewQueueState(details);
        const manualReview = manualReviewState(details);
        const dockerTest = acceptedDockerTestState(details);
        const activeTestRun = row.activeTestRun || null;
        if (activeTestRun?.status === "running") {
          expandedAcceptedRows.add(String(row.id));
        }
        const expanded = expandedAcceptedRows.has(String(row.id));
        const reasons = Array.isArray(row.rejection_reasons) ? row.rejection_reasons : [];
        const manualRepro = buildManualReproText({
          repoFullName: row.repo_full_name,
          repoUrl: row.repo_url,
          prNumber: row.pr_number,
          prUrl: row.pr_url,
          preFixSha: row.pre_fix_sha,
          details,
        });
        const lastTestCommand = Array.isArray(dockerTest.lastRun.testCommand) && dockerTest.lastRun.testCommand.length
          ? shellJoin(dockerTest.lastRun.testCommand)
          : "";
        const dockerfileReasoning = dockerTest.dockerfile.reasoningSummary
          ? `<p class="dockerfile-editor-note" data-accepted-dockerfile-reasoning="${row.id}">${esc(dockerTest.dockerfile.reasoningSummary)}</p>`
          : `<p class="dockerfile-editor-note" data-accepted-dockerfile-reasoning="${row.id}" hidden></p>`;

        return `
          <div class="card accepted-card">
            <div class="accepted-card-header accepted-card-header-compact">
              <div class="accepted-card-summary">
                <div class="accepted-card-summary-main">
                  <strong>${esc(row.repo_full_name)}</strong>
                  <a href="${esc(row.pr_url || "#")}" target="_blank" class="repo-link">PR #${row.pr_number || "—"}</a>
                  ${reviewStatusBadge(review.status)}
                  ${acceptedDockerRunBadge(activeTestRun, dockerTest)}
                  <span class="badge ${usage.used ? "badge-completed" : "badge-warn"}">${usage.used ? "Manual Repro Used" : "Manual Repro Unused"}</span>
                  ${manualReview.rejected ? '<span class="badge badge-rejected">Manual Reject</span>' : ""}
                </div>
                <div class="accepted-card-summary-sub">
                  <span>${row.pr_title ? esc(row.pr_title) : "No PR title saved"}</span>
                  <span>${Array.isArray(row.issues) ? row.issues.length : 0} issue${Array.isArray(row.issues) && row.issues.length === 1 ? "" : "s"}</span>
                  <span>${dockerTest.dockerfile.path ? `Dockerfile: ${esc(dockerTest.dockerfile.path)}` : "Dockerfile: —"}</span>
                  <span>${activeTestRun?.status === "running"
                    ? "Docker tests running"
                    : (dockerTest.lastRun.finishedAt
                      ? `${dockerTest.lastRun.success ? "Docker tests passed" : "Docker tests failed"} ${fmtDate(dockerTest.lastRun.finishedAt)}`
                      : "Docker tests not run")}</span>
                </div>
              </div>
              <div class="accepted-card-actions">
                <button type="button" class="btn btn-sm btn-info" data-deep-scan-accepted="${esc(row.repo_full_name)}">Deep Scan Repo</button>
                <button type="button" class="btn btn-sm" data-toggle-accepted-details="${row.id}" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "Hide Details" : "View Details"}</button>
              </div>
            </div>
            <div class="accepted-card-body" data-accepted-details="${row.id}" ${expanded ? "" : "hidden"}>
              <div class="accepted-card-header">
                <div class="accepted-card-title">
                  <span class="badge badge-accepted">Accepted</span>
                  <span class="badge badge-info">Scan #${row.scan_id}</span>
                  <span class="badge badge-info">${esc(acceptedDockerfileSourceLabel(dockerTest.dockerfile.source))}</span>
                </div>
                <div class="accepted-card-actions">
                  <button type="button" class="btn btn-sm" data-toggle-manual-repro-used="${row.id}" data-used="${usage.used ? "1" : "0"}">${usage.used ? "Mark Unused" : "Mark Used"}</button>
                  <button type="button" class="btn btn-sm btn-danger" data-manual-reject="${row.id}" ${manualReview.rejected ? "disabled" : ""}>${manualReview.rejected ? "Marked Rejected" : "Reject"}</button>
                </div>
              </div>
            ${row.pr_title ? `<p class="accepted-pr-title">${esc(row.pr_title)}</p>` : ""}
            <dl class="detail-kv accepted-meta">
              <dt>Repo</dt><dd><a href="${esc(row.repo_url || "#")}" target="_blank" class="repo-link">${esc(row.repo_full_name)}</a></dd>
              <dt>PR</dt><dd>${row.pr_number ? `<a href="${esc(row.pr_url || "#")}" target="_blank" class="repo-link">#${row.pr_number}</a>` : "—"}</dd>
              <dt>Issue Count</dt><dd>${Array.isArray(row.issues) ? row.issues.length : 0}</dd>
              <dt>Manual Repro</dt><dd>${usage.used ? `Used ${fmtDate(usage.usedAt)}` : "Not used yet"}</dd>
              <dt>Manual Review</dt><dd>${manualReview.rejected ? `Rejected ${fmtDate(manualReview.rejectedAt)}` : "Not manually rejected"}</dd>
            </dl>
            <div class="detail-section">
              <h4>Issues</h4>
              ${renderAcceptedIssues(row.issues)}
            </div>
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
            ${manualReview.rejected ? `<p class="accepted-reasons">${esc(manualReview.reason || "manually rejected by user")}</p>` : ""}
            ${reasons.length ? `<p class="accepted-reasons">${esc(reasons.join(" · "))}</p>` : ""}
            ${manualRepro ? renderManualReproBlock(`accepted-${row.id}`, manualRepro) : ""}
            </div>
          </div>
        `;
      }).join("");

      attachManualReproCopyHandlers(container);

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
            await loadAccepted();
          } catch (err) {
            alert("Failed to update manual repro usage: " + err.message);
            button.disabled = false;
          }
        });
      });

      $$("[data-manual-reject]", container).forEach((button) => {
        button.addEventListener("click", async () => {
          const candidateId = button.dataset.manualReject;
          if (!confirm("Mark this accepted candidate as manually rejected?")) return;
          button.disabled = true;
          try {
            await api(`/api/accepted/${candidateId}/manual-reject`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
            await loadAccepted();
            await loadDashboard();
          } catch (err) {
            alert("Failed to reject candidate: " + err.message);
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
            await loadAccepted();
          } catch (err) {
            alert("Failed to save review: " + err.message);
            button.disabled = false;
          }
        });
      });

      $$("[data-deep-scan-accepted]", container).forEach((button) => {
        button.addEventListener("click", () => {
          prepareSingleRepoDeepScan(button.dataset.deepScanAccepted);
        });
      });

      $$("[data-toggle-accepted-details]", container).forEach((button) => {
        button.addEventListener("click", () => {
          const candidateId = button.dataset.toggleAcceptedDetails;
          const detailsPanel = $(`[data-accepted-details="${candidateId}"]`, container);
          if (!candidateId || !detailsPanel) return;
          const nextExpanded = detailsPanel.hidden;
          detailsPanel.hidden = !nextExpanded;
          if (nextExpanded) {
            expandedAcceptedRows.add(String(candidateId));
          } else {
            expandedAcceptedRows.delete(String(candidateId));
          }
          button.textContent = nextExpanded ? "Hide Details" : "View Details";
          button.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
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
              alert("Failed to load Dockerfile: " + err.message);
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
            alert("Failed to load Dockerfile: " + err.message);
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
                    alert("Failed to load Dockerfile: " + err.message);
                  }
                });
              });
            }
            if (reasoning) {
              reasoning.hidden = !data.reasoningSummary;
              reasoning.textContent = data.reasoningSummary || "";
            }
            const toggleButton = $(`[data-toggle-accepted-dockerfile="${candidateId}"]`, container);
            if (toggleButton) {
              toggleButton.textContent = "Hide Dockerfile";
            }
            const fixButton = $(`[data-fix-accepted-dockerfile="${candidateId}"]`, container);
            if (fixButton) {
              fixButton.disabled = true;
            }
          } catch (err) {
            alert("Failed to generate Dockerfile with Gemini: " + err.message);
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
            alert("Failed to load Dockerfile before running tests: " + err.message);
            return;
          }

          const dockerfilePath = pathInput?.value?.trim();
          const dockerfileContent = contentInput?.value || "";
          if (!dockerfilePath || !dockerfileContent.trim()) {
            alert("Load or generate a Dockerfile before running tests.");
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
            ensureAcceptedTestRunPolling(container);
            void pollAcceptedTestRunStates(container);
          } catch (err) {
            alert("Failed to run Docker tests: " + err.message);
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
            alert("Failed to stop Docker tests: " + err.message);
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
            alert("Failed to load Dockerfile before asking Gemini to fix it: " + err.message);
            return;
          }

          const dockerfilePath = pathInput?.value?.trim();
          const dockerfileContent = contentInput?.value || "";
          const errorOutput = output?.textContent?.trim() || "";
          if (!dockerfilePath || !dockerfileContent.trim()) {
            alert("Load or generate a Dockerfile before asking Gemini to fix it.");
            return;
          }
          if (!errorOutput) {
            alert("Run Docker tests first so there is an error to send to Gemini.");
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
            if (toggleButton) {
              toggleButton.textContent = "Hide Dockerfile";
            }
          } catch (err) {
            alert("Failed to fix Dockerfile with Gemini: " + err.message);
          } finally {
            button.disabled = false;
            button.textContent = "Fix With Gemini";
          }
        });
      });

      rows.forEach((row) => {
        if (!row.activeTestRun) return;
        renderAcceptedTestRunState(container, String(row.id), row.activeTestRun);
        if (row.activeTestRun.status === "running") {
          activeAcceptedTestRuns.add(String(row.id));
        }
      });
      if (activeAcceptedTestRuns.size) {
        ensureAcceptedTestRunPolling(container);
      }

      renderPagination($("#accepted-pagination"), data.total, ACCEPTED_PER_PAGE, acceptedPage, (page) => {
        acceptedPage = page;
        void loadAccepted();
      });
    } catch (err) {
      container.innerHTML = `<div class="card"><div class="empty-state"><p>Error: ${err.message}</p></div></div>`;
      $("#accepted-pagination").innerHTML = "";
    }
  }

  $("#accepted-review-filter").addEventListener("change", (event) => {
    acceptedReviewFilter = event.target.value || "all";
    acceptedPage = 0;
    void loadAccepted();
  });

  /* ---- Issues ---- */
  let issuesPage = 0;
  const ISSUES_PER_PAGE = 20;

  async function loadIssues() {
    try {
      const data = await api(`/api/issues?limit=${ISSUES_PER_PAGE}&offset=${issuesPage * ISSUES_PER_PAGE}`);
      const tbody = $("#issues-tbody");

      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🐛</div><p>No issues yet. Run a scan to discover verified issues.</p></div></td></tr>`;
        $("#issues-pagination").innerHTML = "";
        return;
      }

      tbody.innerHTML = data.rows.map((i) => `
        <tr>
          <td><a href="${esc(i.url || '#')}" target="_blank" class="repo-link">${esc(i.title || `#${i.number}`)}</a></td>
          <td>${esc(i.repo_full_name)}</td>
          <td>#${i.pr_number} — ${esc(i.pr_title || "")}</td>
          <td><span class="badge ${i.state === 'open' ? 'badge-open' : 'badge-closed'}">${i.state || "—"}</span></td>
          <td>${esc(i.link_type)}</td>
        </tr>
      `).join("");

      renderPagination($("#issues-pagination"), data.total, ISSUES_PER_PAGE, issuesPage, (p) => { issuesPage = p; loadIssues(); });
    } catch (err) {
      $("#issues-tbody").innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Error: ${err.message}</p></div></td></tr>`;
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
      minStars: Number($("#f-min-stars").value) || 50,
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

  /* ---- Page loader ---- */
  function loadPage(page) {
    switch (page) {
      case "dashboard": loadDashboard(); break;
      case "repos": loadRepos(); break;
      case "accepted": loadAccepted(); break;
      case "issues": loadIssues(); break;
      case "scans": loadScans(); break;
      case "new-scan": checkActiveScan(); break;
    }
  }

  /* ---- Init ---- */
  bindDashboardActions($("#page-dashboard"));
  loadDashboard();
})();
