import React, { useState, useEffect } from 'react';

const INITIAL_SUBMISSIONS = [
  {
    id: 1,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Design",
    title: "Ui design",
    summary: "nothing checking UI design",
    submitted: "2026-08-03",
    reviewer: "Yaswanth Telaprolu",
    status: "Approved",
    aiScore: 84
  },
  {
    id: 2,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Report",
    title: "checking the design of the Ui",
    summary: "checking the design of the Ui",
    submitted: "2026-08-03",
    reviewer: "yaswanth",
    status: "Pending",
    aiScore: 78
  },
  {
    id: 3,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Code Review",
    title: "Backend Auth Refactor",
    summary: "Refactored auth controller and JWT validation logic",
    submitted: "2026-08-02",
    reviewer: "Yaswanth Telaprolu",
    status: "Pending",
    aiScore: 81
  },
  {
    id: 4,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Document",
    title: "Q3 Performance Plan",
    summary: "Team objectives, key performance metrics, and deliverables",
    submitted: "2026-08-01",
    reviewer: "Yaswanth Telaprolu",
    status: "In Review",
    aiScore: 94
  },
  {
    id: 5,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Presentation",
    title: "Product Strategy Deck",
    summary: "Strategy and product roadmap deck for executive review",
    submitted: "2026-07-31",
    reviewer: "Yaswanth Telaprolu",
    status: "In Review",
    aiScore: 79
  },
  {
    id: 6,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Image",
    title: "Brand Identity Assets",
    summary: "Exported SVG vector graphics and brand collateral assets",
    submitted: "2026-07-30",
    reviewer: "Yaswanth Telaprolu",
    status: "Rejected",
    aiScore: 93
  },
  {
    id: 7,
    employee: "Yaswanth Telaprolu",
    email: "yaswanth@eversoft.com",
    type: "Document",
    title: "Legacy Migration Spec",
    summary: "Detailed specification document for legacy API database migration",
    submitted: "2026-07-29",
    reviewer: "Yaswanth Telaprolu",
    status: "Rejected",
    aiScore: 72
  }
];

export default function WorkSubmissions() {
  const [submissions, setSubmissions] = useState(INITIAL_SUBMISSIONS);
  const [filterStatus, setFilterStatus] = useState("Approved");
  const [searchQuery, setSearchQuery] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newReviewer, setNewReviewer] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Load from backend API
  useEffect(() => {
    fetch("/api/submissions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const mapped = data.map((item) => ({
            id: item.id,
            employee: item.employee || item.employee_name || "Yaswanth Telaprolu",
            email: item.email || "",
            type: item.type || "Document",
            title: item.title,
            summary: item.summary || item.notes || "",
            submitted: item.date || item.submitted || new Date().toISOString().split("T")[0],
            reviewer: item.reviewer || "Yaswanth Telaprolu",
            status: item.status || "Pending",
            aiScore: item.aiScore ?? item.ai_score ?? Math.floor(Math.random() * 20 + 78)
          }));
          setSubmissions(mapped);
        }
      })
      .catch(() => {});
  }, []);

  const totalCount = submissions.length;
  const approvedCount = submissions.filter((s) => s.status === "Approved").length;
  const pendingCount = submissions.filter((s) => s.status === "Pending").length;
  const inReviewCount = submissions.filter((s) => s.status === "In Review").length;
  const rejectedCount = submissions.filter((s) => s.status === "Rejected").length;

  const approvedPct = totalCount > 0 ? Math.round((approvedCount / totalCount) * 100) : 0;

  // Status distribution bar percentages
  const pendingPct = totalCount > 0 ? (pendingCount / totalCount) * 100 : 0;
  const inReviewPct = totalCount > 0 ? (inReviewCount / totalCount) * 100 : 0;
  const approvedBarPct = totalCount > 0 ? (approvedCount / totalCount) * 100 : 0;
  const rejectedPct = totalCount > 0 ? (rejectedCount / totalCount) * 100 : 0;

  // Filtered submissions
  const filteredSubmissions = submissions
    .filter((item) => {
      if (filterStatus === "All") return true;
      return item.status === filterStatus;
    })
    .filter((item) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        (item.employee && item.employee.toLowerCase().includes(q)) ||
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.type && item.type.toLowerCase().includes(q)) ||
        (item.reviewer && item.reviewer.toLowerCase().includes(q))
      );
    });

  // Handle status update (Approve, Reject, In Review)
  const handleUpdateStatus = (id, newStatus) => {
    let reviewerName = "Yaswanth Telaprolu";
    try {
      const sess = JSON.parse(localStorage.getItem("hrms_session") || "{}");
      if (sess.name) reviewerName = sess.name;
    } catch (e) {}

    setSubmissions((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status: newStatus, reviewer: reviewerName } : item
      )
    );

    fetch(`/api/submissions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus, reviewer: reviewerName })
    }).catch(() => {});
  };

  // Handle New Submission submit
  const handleCreateSubmission = (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setSubmitting(true);
    let empName = "Yaswanth Telaprolu";
    let empEmail = "yaswanth@eversoft.com";
    try {
      const sess = JSON.parse(localStorage.getItem("hrms_session") || "{}");
      if (sess.name) empName = sess.name;
      if (sess.email) empEmail = sess.email;
    } catch (err) {}

    const newSub = {
      email: empEmail,
      employee: empName,
      title: newTitle,
      type: selectedFile ? "Image" : "Document",
      summary: newNotes,
      reviewer: newReviewer || "Yaswanth Telaprolu",
      status: "Pending",
      aiScore: Math.floor(Math.random() * 18 + 78),
      date: new Date().toISOString().split("T")[0],
      fileName: selectedFile ? selectedFile.name : ""
    };

    fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSub)
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((created) => {
        const itemToAdd = created && created.id ? { ...newSub, id: created.id } : { ...newSub, id: Date.now() };
        setSubmissions((prev) => [itemToAdd, ...prev]);
      })
      .catch(() => {
        setSubmissions((prev) => [{ ...newSub, id: Date.now() }, ...prev]);
      })
      .finally(() => {
        setSubmitting(false);
        setShowModal(false);
        setNewTitle("");
        setNewReviewer("");
        setNewNotes("");
        setSelectedFile(null);
      });
  };

  const getInitials = (name) => {
    if (!name) return "YT";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const getTypeBadgeStyle = (type) => {
    switch (type) {
      case "Design":
        return { bg: "#eff6ff", color: "#3b82f6", border: "#bfdbfe" };
      case "Image":
        return { bg: "#f3e8ff", color: "#a855f7", border: "#e9d5ff" };
      case "Presentation":
        return { bg: "#ecfdf5", color: "#10b981", border: "#a7f3d0" };
      case "Code Review":
        return { bg: "#e0e7ff", color: "#6366f1", border: "#c7d2fe" };
      case "Report":
        return { bg: "#fffbe6", color: "#d97706", border: "#fde68a" };
      default:
        return { bg: "#f3f4f6", color: "#4b5563", border: "#e5e7eb" };
    }
  };

  const getScoreColor = (score) => {
    if (score >= 85) return "#10b981"; // green
    if (score >= 75) return "#d97706"; // amber/orange
    return "#ef4444"; // red
  };

  return (
    <div className="work-submissions-container" style={{ padding: "8px 4px 40px" }}>
      {/* Top Header Title */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #1e293b)", margin: 0 }}>
          Work Submissions
        </h1>
      </div>

      {/* Top 4 Stat Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
          marginBottom: 20
        }}
      >
        {/* TOTAL */}
        <div
          style={{
            background: "var(--bg2, #ffffff)",
            border: "1px solid var(--border2, #e2e8f0)",
            borderTop: "3px solid #3b82f6",
            borderRadius: 12,
            padding: "16px 20px",
            position: "relative",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                TOTAL
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #0f172a)", margin: "4px 0" }}>
                {totalCount}
              </div>
              <div style={{ fontSize: 12, color: "var(--text3, #64748b)" }}>
                All submissions
              </div>
            </div>
            <div style={{ color: "#3b82f6", padding: 6, borderRadius: 8, background: "rgba(59,130,246,0.08)" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
          </div>
        </div>

        {/* APPROVED */}
        <div
          style={{
            background: "var(--bg2, #ffffff)",
            border: "1px solid var(--border2, #e2e8f0)",
            borderTop: "3px solid #10b981",
            borderRadius: 12,
            padding: "16px 20px",
            position: "relative",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                APPROVED
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #0f172a)", margin: "4px 0" }}>
                {approvedCount}
              </div>
              <div style={{ fontSize: 12, color: "var(--text3, #64748b)" }}>
                {approvedPct}% of total
              </div>
            </div>
            <div style={{ color: "#10b981", padding: 6, borderRadius: 8, background: "rgba(16,185,129,0.08)" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>

        {/* PENDING REVIEW */}
        <div
          style={{
            background: "var(--bg2, #ffffff)",
            border: "1px solid var(--border2, #e2e8f0)",
            borderTop: "3px solid #f59e0b",
            borderRadius: 12,
            padding: "16px 20px",
            position: "relative",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                PENDING REVIEW
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #0f172a)", margin: "4px 0" }}>
                {pendingCount}
              </div>
              <div style={{ fontSize: 12, color: "var(--text3, #64748b)" }}>
                Awaiting first look
              </div>
            </div>
            <div style={{ color: "#f59e0b", padding: 6, borderRadius: 8, background: "rgba(245,158,11,0.08)" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>

        {/* IN REVIEW */}
        <div
          style={{
            background: "var(--bg2, #ffffff)",
            border: "1px solid var(--border2, #e2e8f0)",
            borderTop: "3px solid #8b5cf6",
            borderRadius: 12,
            padding: "16px 20px",
            position: "relative",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3, #64748b)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                IN REVIEW
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #0f172a)", margin: "4px 0" }}>
                {inReviewCount}
              </div>
              <div style={{ fontSize: 12, color: "var(--text3, #64748b)" }}>
                Being evaluated
              </div>
            </div>
            <div style={{ color: "#8b5cf6", padding: 6, borderRadius: 8, background: "rgba(139,92,246,0.08)" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Progress Bar & Legend Section */}
      <div
        style={{
          background: "var(--bg2, #ffffff)",
          border: "1px solid var(--border2, #e2e8f0)",
          borderRadius: 12,
          padding: "14px 20px",
          marginBottom: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          {/* Multi-segment Horizontal Progress Bar */}
          <div
            style={{
              flex: 1,
              minWidth: 260,
              height: 10,
              borderRadius: 6,
              background: "#e2e8f0",
              overflow: "hidden",
              display: "flex"
            }}
          >
            <div style={{ width: `${pendingPct}%`, background: "#f59e0b", transition: "width 0.3s" }} title={`Pending: ${pendingCount}`} />
            <div style={{ width: `${inReviewPct}%`, background: "#3b82f6", transition: "width 0.3s" }} title={`In Review: ${inReviewCount}`} />
            <div style={{ width: `${approvedBarPct}%`, background: "#10b981", transition: "width 0.3s" }} title={`Approved: ${approvedCount}`} />
            <div style={{ width: `${rejectedPct}%`, background: "#ef4444", transition: "width 0.3s" }} title={`Rejected: ${rejectedCount}`} />
          </div>

          {/* Right side Status Legend */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 12.5, fontWeight: 500, color: "var(--text2, #334155)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b" }} />
              Pending <strong style={{ color: "var(--text, #0f172a)" }}>{pendingCount}</strong>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3b82f6" }} />
              In Review <strong style={{ color: "var(--text, #0f172a)" }}>{inReviewCount}</strong>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981" }} />
              Approved <strong style={{ color: "var(--text, #0f172a)" }}>{approvedCount}</strong>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }} />
              Rejected <strong style={{ color: "var(--text, #0f172a)" }}>{rejectedCount}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Main Table Card Area */}
      <div
        style={{
          background: "var(--bg2, #ffffff)",
          border: "1px solid var(--border2, #e2e8f0)",
          borderRadius: 16,
          padding: 24,
          boxShadow: "0 2px 8px rgba(0,0,0,0.03)"
        }}
      >
        {/* Submission Queue Header & Action */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
          <div style={{ borderLeft: "4px solid #3b82f6", paddingLeft: 12 }}>
            <h2 style={{ fontSize: 19, fontWeight: 700, fontFamily: "var(--font-d, sans-serif)", color: "var(--text, #0f172a)", margin: 0 }}>
              Submission Queue
            </h2>
            <p style={{ fontSize: 12.5, color: "var(--text3, #64748b)", margin: "4px 0 0" }}>
              Review, approve and track work submitted across the team
            </p>
          </div>

          <button
            onClick={() => setShowModal(true)}
            style={{
              background: "#2563eb",
              color: "#ffffff",
              border: "none",
              borderRadius: 9,
              padding: "10px 20px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
              transition: "all 0.15s ease"
            }}
          >
            <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>+</span> New Submission
          </button>
        </div>

        {/* Filter Pills & Search Input Row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 14 }}>
          {/* Left Filter Pills */}
          <div style={{ display: "flex", gap: 8, background: "var(--bg3, #f8fafc)", padding: 4, borderRadius: 12, border: "1px solid var(--border2, #f1f5f9)" }}>
            {[
              { id: "All", count: totalCount },
              { id: "Pending", count: pendingCount },
              { id: "In Review", count: inReviewCount },
              { id: "Approved", count: approvedCount },
              { id: "Rejected", count: rejectedCount }
            ].map((tab) => {
              const isActive = filterStatus === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setFilterStatus(tab.id)}
                  style={{
                    background: isActive ? "#2563eb" : "transparent",
                    color: isActive ? "#ffffff" : "var(--text2, #475569)",
                    border: "none",
                    borderRadius: 8,
                    padding: "7px 14px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    transition: "all 0.15s ease"
                  }}
                >
                  {tab.id}
                  <span
                    style={{
                      background: isActive ? "rgba(255,255,255,0.25)" : "var(--border2, #e2e8f0)",
                      color: isActive ? "#ffffff" : "var(--text3, #64748b)",
                      borderRadius: "50%",
                      width: 18,
                      height: 18,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      fontWeight: 700
                    }}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right Search Input */}
          <div style={{ position: "relative", minWidth: 240 }}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text3, #94a3b8)" }}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search submissions"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                background: "var(--bg2, #ffffff)",
                border: "1px solid var(--border2, #cbd5e1)",
                borderRadius: 9,
                padding: "8px 12px 8px 34px",
                fontSize: 12.5,
                color: "var(--text, #0f172a)",
                outline: "none",
                boxSizing: "border-box"
              }}
            />
          </div>
        </div>

        {/* Submissions Table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr style={{ background: "var(--bg3, #f8fafc)" }}>
                {["EMPLOYEE", "TYPE", "TITLE", "SUBMITTED", "REVIEWER", "STATUS", "AI SCORE", "ACTION"].map((col, idx) => (
                  <th
                    key={col}
                    style={{
                      padding: "12px 14px",
                      textAlign: col === "AI SCORE" || col === "ACTION" ? "center" : "left",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--text3, #64748b)",
                      letterSpacing: "0.5px",
                      borderBottom: "1px solid var(--border2, #e2e8f0)",
                      borderTopLeftRadius: idx === 0 ? 8 : 0,
                      borderBottomLeftRadius: idx === 0 ? 8 : 0,
                      borderTopRightRadius: idx === 7 ? 8 : 0,
                      borderBottomRightRadius: idx === 7 ? 8 : 0
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredSubmissions.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ padding: "40px", textAlign: "center", color: "var(--text3, #94a3b8)", fontSize: 13 }}>
                    No work submissions found matching your filters.
                  </td>
                </tr>
              ) : (
                filteredSubmissions.map((row) => {
                  const typeStyle = getTypeBadgeStyle(row.type);
                  const scoreColor = getScoreColor(row.aiScore);

                  return (
                    <tr
                      key={row.id}
                      style={{
                        borderBottom: "1px solid var(--border2, #f1f5f9)",
                        transition: "background 0.15s ease"
                      }}
                    >
                      {/* EMPLOYEE */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: "50%",
                              background: "linear-gradient(135deg, #f97316, #fb923c)",
                              color: "#ffffff",
                              fontSize: 11,
                              fontWeight: 700,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0
                            }}
                          >
                            {getInitials(row.employee)}
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #0f172a)" }}>
                            {row.employee}
                          </span>
                        </div>
                      </td>

                      {/* TYPE */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)" }}>
                        <span
                          style={{
                            background: typeStyle.bg,
                            color: typeStyle.color,
                            border: `1px solid ${typeStyle.border}`,
                            borderRadius: 6,
                            padding: "4px 10px",
                            fontSize: 11,
                            fontWeight: 600,
                            display: "inline-block"
                          }}
                        >
                          {row.type}
                        </span>
                      </td>

                      {/* TITLE & SUMMARY */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text, #0f172a)" }}>
                          {row.title}
                        </div>
                        {row.summary && (
                          <div style={{ fontSize: 11.5, color: "var(--text3, #64748b)", marginTop: 2, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.summary}
                          </div>
                        )}
                      </td>

                      {/* SUBMITTED */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)", fontSize: 12, color: "var(--text2, #475569)", whiteSpace: "nowrap" }}>
                        {row.submitted}
                      </td>

                      {/* REVIEWER */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)" }}>
                        {row.reviewer ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div
                              style={{
                                width: 24,
                                height: 24,
                                borderRadius: "50%",
                                background: "linear-gradient(135deg, #fdba74, #f97316)",
                                color: "#ffffff",
                                fontSize: 9.5,
                                fontWeight: 700,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0
                              }}
                            >
                              {getInitials(row.reviewer)}
                            </div>
                            <span style={{ fontSize: 12, color: "var(--text2, #334155)" }}>
                              {row.reviewer}
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: "var(--text3, #94a3b8)", fontSize: 12 }}>—</span>
                        )}
                      </td>

                      {/* STATUS */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)" }}>
                        {row.status === "Approved" && (
                          <span style={{ background: "#ecfdf5", color: "#10b981", border: "1px solid #a7f3d0", borderRadius: 12, padding: "4px 12px", fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }} /> Approved
                          </span>
                        )}
                        {row.status === "Pending" && (
                          <span style={{ background: "#fffbe6", color: "#d97706", border: "1px solid #fde68a", borderRadius: 12, padding: "4px 12px", fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d97706" }} /> Pending
                          </span>
                        )}
                        {row.status === "In Review" && (
                          <span style={{ background: "#eff6ff", color: "#3b82f6", border: "1px solid #bfdbfe", borderRadius: 12, padding: "4px 12px", fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} /> In Review
                          </span>
                        )}
                        {row.status === "Rejected" && (
                          <span style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", borderRadius: 12, padding: "4px 12px", fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444" }} /> Rejected
                          </span>
                        )}
                      </td>

                      {/* AI Score Circular Progress Bar */}
                      <td style={{ padding: '14px', borderBottom: '1px solid var(--border2, #f1f5f9)', textAlign: 'center' }}>
                        {(() => {
                          const score = row.aiScore ?? 84;
                          const r = 14;
                          const circ = 2 * Math.PI * r;
                          const offset = circ - (score / 100) * circ;
                          const color = score >= 85 ? '#10b981' : score >= 75 ? '#d97706' : '#ef4444';
                          return (
                            <div style={{ position: 'relative', width: 36, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                              <svg width="36" height="36" viewBox="0 0 36 36" style={{ transform: 'rotate(-90deg)' }}>
                                <circle cx="18" cy="18" r="14" stroke="var(--border2, #e2e8f0)" strokeWidth="4" fill="transparent" />
                                <circle cx="18" cy="18" r="14" stroke={color} strokeWidth="4" strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" fill="transparent" style={{ transition: 'stroke-dashoffset 0.4s ease' }} />
                              </svg>
                              <span style={{ position: 'absolute', fontSize: 12, fontWeight: 800, fontFamily: 'var(--font-d, sans-serif)', color: color }}>
                                {score}
                              </span>
                            </div>
                          );
                        })()}
                      </td>

                      {/* ACTION */}
                      <td style={{ padding: "14px", borderBottom: "1px solid var(--border2, #f1f5f9)", textAlign: "center" }}>
                        {row.status === "Pending" || row.status === "In Review" ? (
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <button
                              onClick={() => handleUpdateStatus(row.id, "In Review")}
                              style={{
                                background: "#eff6ff",
                                color: "#2563eb",
                                border: "1px solid #bfdbfe",
                                borderRadius: 6,
                                padding: "4px 10px",
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: "pointer"
                              }}
                            >
                              Review
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(row.id, "Approved")}
                              style={{
                                background: "#ecfdf5",
                                color: "#059669",
                                border: "1px solid #a7f3d0",
                                borderRadius: 6,
                                padding: "4px 10px",
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: "pointer"
                              }}
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(row.id, "Rejected")}
                              style={{
                                background: "#fef2f2",
                                color: "#dc2626",
                                border: "1px solid #fecaca",
                                borderRadius: 6,
                                padding: "4px 10px",
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: "pointer"
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span style={{ color: "var(--text3, #94a3b8)", fontSize: 14 }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Submission Modal (Matching Image 2) */}
      {showModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(4px)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
        >
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 16,
              width: "100%",
              maxWidth: 520,
              padding: 24,
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
              animation: "fadeIn 0.15s ease"
            }}
          >
            {/* Modal Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: 0 }}>
                New Submission
              </h3>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  background: "#e2e8f0",
                  border: "none",
                  borderRadius: "50%",
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: 14,
                  color: "#64748b"
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleCreateSubmission}>
              {/* Field 1: Title */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  Title <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Q2 Strategy Document"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  style={{
                    width: "100%",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: "#0f172a",
                    outline: "none",
                    boxSizing: "border-box"
                  }}
                />
              </div>

              {/* Field 2: Reviewer */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  Reviewer <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Manager name"
                  value={newReviewer}
                  onChange={(e) => setNewReviewer(e.target.value)}
                  style={{
                    width: "100%",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: "#0f172a",
                    outline: "none",
                    boxSizing: "border-box"
                  }}
                />
              </div>

              {/* Field 3: Attachment */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  Attachment
                </label>
                <div
                  onClick={() => document.getElementById("file-upload-input").click()}
                  style={{
                    border: "1.5px dashed #cbd5e1",
                    borderRadius: 10,
                    padding: "24px",
                    background: "#f1f5f9",
                    textAlign: "center",
                    cursor: "pointer",
                    transition: "all 0.15s ease"
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: "#e0e7ff",
                      color: "#4f46e5",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: 8
                    }}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
                    {selectedFile ? selectedFile.name : "Click to upload or drop a file"}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>
                    {selectedFile ? `${(selectedFile.size / 1024).toFixed(1)} KB` : "Attach the work you are submitting"}
                  </div>
                  <input
                    id="file-upload-input"
                    type="file"
                    style={{ display: "none" }}
                    onChange={(e) => setSelectedFile(e.target.files[0])}
                  />
                </div>
              </div>

              {/* Field 4: Notes */}
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  Notes
                </label>
                <textarea
                  rows="3"
                  placeholder="Add context for your reviewer.."
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  style={{
                    width: "100%",
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: "#0f172a",
                    outline: "none",
                    resize: "vertical",
                    fontFamily: "inherit",
                    boxSizing: "border-box"
                  }}
                />
              </div>

              {/* Modal Footer Buttons */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  style={{
                    background: "#e2e8f0",
                    color: "#334155",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 18px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    background: "#2563eb",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 22px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    boxShadow: "0 2px 4px rgba(37,99,235,0.2)"
                  }}
                >
                  {submitting ? "Submitting..." : "Submit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
