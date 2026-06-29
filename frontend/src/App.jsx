import React, { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Bookmark, 
  ExternalLink
} from 'lucide-react'
import BlobCursor from './BlobCursor'

const API_BASE = 'http://localhost:8080/api'

// ==========================================================================
// ScrambleText Component (Vibe Scrambler)
// ==========================================================================
const ScrambleText = ({ text, delay = 0 }) => {
  const [displayText, setDisplayText] = useState('')
  const chars = '!<>-_\\/[]{}—=+*^?#________01010101'
  
  useEffect(() => {
    let active = true
    let frame = 0
    const duration = 1.2
    const totalFrames = Math.floor(duration * 60)
    const queue = []

    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char === ' ') {
        queue.push({ from: ' ', to: ' ', start: 0, end: totalFrames })
        continue
      }
      const start = Math.floor(Math.random() * (totalFrames * 0.6))
      const end = start + Math.floor(Math.random() * (totalFrames * 0.4)) + (totalFrames * 0.1)
      queue.push({ from: '', to: char, start, end, char: '' })
    }

    const timer = setTimeout(() => {
      const update = () => {
        if (!active) return
        let output = ''
        let complete = 0

        for (let i = 0; i < queue.length; i++) {
          const item = queue[i]
          if (frame >= item.end) {
            complete++
            output += item.to
          } else if (frame >= item.start) {
            if (!item.char || Math.random() < 0.28) {
              item.char = chars[Math.floor(Math.random() * chars.length)]
            }
            output += item.char
          } else {
            output += ''
          }
        }

        setDisplayText(output)

        if (complete < queue.length) {
          frame++
          requestAnimationFrame(update)
        } else {
          setDisplayText(text)
        }
      }
      update()
    }, delay)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [text, delay])

  return <span>{displayText}</span>
}

// ==========================================================================
// Interactive Glow Card Wrapper
// ==========================================================================
const GlowCard = ({ children, className = '' }) => {
  const cardRef = useRef(null)

  const handleMouseMove = (e) => {
    if (!cardRef.current) return
    const rect = cardRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    cardRef.current.style.setProperty('--mouse-x', `${x}px`)
    cardRef.current.style.setProperty('--mouse-y', `${y}px`)
  }

  return (
    <div 
      ref={cardRef} 
      className={`bounty-card ${className}`}
      onMouseMove={handleMouseMove}
    >
      <div className="bounty-card-glow"></div>
      <div className="bounty-card-inner">
        {children}
      </div>
    </div>
  )
}

// ==========================================================================
// Main App Component
// ==========================================================================
function App() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('feed')
  
  // Feed Filters
  const [search, setSearch] = useState('')
  const [language, setLanguage] = useState('All')
  const [minAmount, setMinAmount] = useState('')

  // --------------------------------------------------------------------------
  // TanStack Queries & Mutations
  // --------------------------------------------------------------------------
  
  // 1. Fetch Bounties Feed
  const { data: bounties = [], isLoading: loadingBounties, refetch: refetchBounties } = useQuery({
    queryKey: ['bounties', search, language, minAmount],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (search) params.append('search', search)
      if (language && language !== 'All') params.append('language', language)
      if (minAmount) params.append('min_amount', minAmount)
      
      const res = await fetch(`${API_BASE}/bounties?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to fetch bounties')
      return res.json()
    }
  })

  // 2. Fetch Dashboard Stats
  const { data: stats = { total_saved: 0, funnel_stats: {}, earnings_record: {} }, refetch: refetchStats } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/dashboard`)
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    }
  })

  // 3. Fetch Settings
  const { data: settings = {}, refetch: refetchSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/settings`)
      if (!res.ok) throw new Error('Failed to fetch settings')
      return res.json()
    }
  })

  // 3b. Fetch Subscribers
  const { data: subscribers = [], refetch: refetchSubscribers } = useQuery({
    queryKey: ['subscribers'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/subscribers`)
      if (!res.ok) throw new Error('Failed to fetch subscribers')
      return res.json()
    }
  })

  // 4. Mutation: Save Bounty
  const saveMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await fetch(`${API_BASE}/bounties/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonPayloadHelper(payload)
      })
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['bounties'])
      queryClient.invalidateQueries(['stats'])
    }
  })

  // 5. Mutation: Unsave Bounty
  const unsaveMutation = useMutation({
    mutationFn: async (bountyIssueId) => {
      const res = await fetch(`${API_BASE}/bounties/unsave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bounty_issue_id: bountyIssueId })
      })
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['bounties'])
      queryClient.invalidateQueries(['stats'])
    }
  })

  // 6. Mutation: Update Pipeline Status
  const statusMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      const res = await fetch(`${API_BASE}/bounties/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      })
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['bounties'])
      queryClient.invalidateQueries(['stats'])
    }
  })

  // 7. Mutation: Manual Sync
  const [syncing, setSyncing] = useState(false)
  const [selectedBounty, setSelectedBounty] = useState(null)
  const syncMutation = useMutation({
    mutationFn: async () => {
      setSyncing(true)
      const res = await fetch(`${API_BASE}/bounties/sync`, { method: 'POST' })
      return res.json()
    },
    onSuccess: () => {
      setSyncing(false)
      queryClient.invalidateQueries(['bounties'])
      queryClient.invalidateQueries(['stats'])
      alert('GitHub Sync complete!')
    },
    onError: (err) => {
      setSyncing(false)
      alert(`Sync failed: ${err.message}`)
    }
  })

  // Helper JSON builder
  const jsonPayloadHelper = (data) => JSON.stringify(data)

  // --------------------------------------------------------------------------
  // Settings Form State
  // --------------------------------------------------------------------------
  const [formSettings, setFormSettings] = useState({
    github_token: '',
    email: '',
    min_bounty_amount: 0,
    filter_languages: '',
    smtp_host: '',
    smtp_port: 587,
    smtp_user: '',
    smtp_pass: '',
    digest_time: '09:00',
    notification_mode: 'both',
    sync_interval_mins: 60,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00'
  })

  useEffect(() => {
    if (settings && Object.keys(settings).length > 0) {
      setFormSettings({
        github_token: settings.github_token || '',
        email: settings.email || '',
        min_bounty_amount: settings.min_bounty_amount || 0,
        filter_languages: settings.filter_languages || '',
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || 587,
        smtp_user: settings.smtp_user || '',
        smtp_pass: settings.smtp_pass || '',
        digest_time: settings.digest_time || '09:00',
        notification_mode: settings.notification_mode || 'both',
        sync_interval_mins: settings.sync_interval_mins || 60,
        quiet_hours_start: settings.quiet_hours_start || '22:00',
        quiet_hours_end: settings.quiet_hours_end || '08:00'
      })
    }
  }, [settings])

  const settingsMutation = useMutation({
    mutationFn: async (payload) => {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['settings'])
      alert('System Settings saved successfully!')
    }
  })

  const [testEmailLoading, setTestEmailLoading] = useState(false)
  const handleTestEmail = async () => {
    setTestEmailLoading(true)
    try {
      const res = await fetch(`${API_BASE}/settings/test-email`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok) {
        alert(data.message || 'Test email sent successfully!')
      } else {
        alert(data.error || 'Failed to send test email.')
      }
    } catch (err) {
      alert('Network error when sending test email: ' + err.message)
    } finally {
      setTestEmailLoading(false)
    }
  }

  const [newSubEmail, setNewSubEmail] = useState('')

  const addSubMutation = useMutation({
    mutationFn: async (email) => {
      const res = await fetch(`${API_BASE}/subscribers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to add subscriber')
      return data
    },
    onSuccess: () => {
      setNewSubEmail('')
      queryClient.invalidateQueries(['subscribers'])
    },
    onError: (err) => {
      alert(err.message)
    }
  })

  const deleteSubMutation = useMutation({
    mutationFn: async (id) => {
      const res = await fetch(`${API_BASE}/subscribers/${id}`, {
        method: 'DELETE'
      })
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['subscribers'])
    }
  })

  const handleSettingsSubmit = (e) => {
    e.preventDefault()
    settingsMutation.mutate(formSettings)
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  const getRelativeTime = (dateStr) => {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now - d
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    return `${diffDays}d ago`
  }

  return (
    <div className="app-container">
      <BlobCursor
        blobType="circle"
        fillColor="#7affb4"
        trailCount={3}
        sizes={[12, 10, 8]}
        innerSizes={[4, 3, 2]}
        innerColor="#7affb4"
        opacities={[0.8, 0.6, 0.4]}
        shadowColor="rgba(0,0,0,0.5)"
        shadowBlur={2}
        shadowOffsetX={2}
        shadowOffsetY={2}
        useFilter={false}
        fastDuration={0.08}
        slowDuration={0.35}
        zIndex={100000}
      />
      {/* Navigation Header */}
      <header className="nav-header">
        <div class="nav-container">
          <div className="brand-wrapper">
            <a href="#" className="brand-logo" onClick={() => setActiveTab('feed')}>
              <img src="/logo.png" alt="BountyHub Logo" className="brand-logo-img" />
              BountyHub
            </a>
          </div>

          <nav className="tabs-wrapper">
            <button 
              className={`tab-button ${activeTab === 'feed' ? 'active' : ''}`}
              onClick={() => setActiveTab('feed')}
            >
              Bounties Feed
            </button>
            <button 
              className={`tab-button ${activeTab === 'saved' ? 'active' : ''}`}
              onClick={() => setActiveTab('saved')}
            >
              Pipeline Tracker
            </button>
            <button 
              className={`tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              Analytics
            </button>
            <button 
              className={`tab-button ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              System Settings
            </button>
          </nav>

          <button 
            className="rolling-btn" 
            onClick={() => syncMutation.mutate()}
            disabled={syncing}
          >
            <span className="rolling-btn-text" data-text="Sync GitHub PAT">
              {syncing ? 'Syncing...' : 'Sync GitHub'}
            </span>
          </button>
        </div>
      </header>

      {/* Ribbon metrics */}
      <div className="dashboard-ribbon">
        <div className="dashboard-ribbon-track">
          <span>Total Saved: {stats.total_saved}</span>
          <span className="divider">•</span>
          <span>Bounties Active: {bounties.length}</span>
          <span className="divider">•</span>
          <span>System Status: Operational</span>
          <span className="divider">•</span>
          <span>Cron Schedule: Daily 00:00</span>
          <span className="divider">•</span>
          <span>Total Saved: {stats.total_saved}</span>
          <span className="divider">•</span>
          <span>Bounties Active: {bounties.length}</span>
          <span className="divider">•</span>
          <span>System Status: Operational</span>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="main-content">
        
        {/* ==================================================================
            TAB 1: BOUNTIES FEED
            ================================================================== */}
        {activeTab === 'feed' && (
          <div>
            <div 
              className="hero-section"
              onMouseMove={(e) => {
                const threshold = 180;
                const maxShift = 70;
                const wrappers = e.currentTarget.querySelectorAll('.star-dot-wrapper');
                
                wrappers.forEach(wrapper => {
                  const rect = wrapper.getBoundingClientRect();
                  const dotX = rect.left + rect.width / 2;
                  const dotY = rect.top + rect.height / 2;
                  
                  const dx = dotX - e.clientX;
                  const dy = dotY - e.clientY;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  
                  if (dist < threshold) {
                    const force = (threshold - dist) / threshold;
                    const shift = force * maxShift;
                    const angle = Math.atan2(dy, dx);
                    const tx = Math.cos(angle) * shift;
                    const ty = Math.sin(angle) * shift;
                    wrapper.style.setProperty('--magnet-x', `${tx}px`);
                    wrapper.style.setProperty('--magnet-y', `${ty}px`);
                  } else {
                    wrapper.style.setProperty('--magnet-x', '0px');
                    wrapper.style.setProperty('--magnet-y', '0px');
                  }
                });
              }}
              onMouseLeave={(e) => {
                const wrappers = e.currentTarget.querySelectorAll('.star-dot-wrapper');
                wrappers.forEach(wrapper => {
                  wrapper.style.setProperty('--magnet-x', '0px');
                  wrapper.style.setProperty('--magnet-y', '0px');
                });
              }}
            >
              <div className="hero-rainbow-glow"></div>
              {/* Star-like dots flying around in wrappers */}
              <div className="star-dot-wrapper" style={{ top: '15%', left: '25%' }}>
                <div className="star-dot" style={{ animationDelay: '0s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '35%', left: '72%' }}>
                <div className="star-dot" style={{ animationDelay: '1.2s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '65%', left: '18%' }}>
                <div className="star-dot" style={{ animationDelay: '0.6s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '78%', left: '80%' }}>
                <div className="star-dot" style={{ animationDelay: '2.1s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '22%', left: '48%' }}>
                <div className="star-dot" style={{ animationDelay: '3.4s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '50%', left: '62%' }}>
                <div className="star-dot" style={{ animationDelay: '0.3s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '72%', left: '35%' }}>
                <div className="star-dot" style={{ animationDelay: '1.8s' }}></div>
              </div>
              <div className="star-dot-wrapper" style={{ top: '10%', left: '82%' }}>
                <div className="star-dot" style={{ animationDelay: '2.7s' }}></div>
              </div>
              
              <h1 className="hero-title">
                <ScrambleText text="Search Github Bounties with ease." />
              </h1>
              <button 
                className="rolling-btn hero-cta"
                onClick={() => {
                  document.querySelector('.filters-bar')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                <span className="rolling-btn-text" data-text="Explore Bounties">Explore Bounties</span>
              </button>
            </div>

            {/* Filter controls */}
            <div className="filters-bar">
              <input 
                type="text" 
                placeholder="Search issues, rewards, bodies..." 
                className="search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              
              <select 
                className="select-filter"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="All">All Tags</option>
                <option value="Go">Go</option>
                <option value="Rust">Rust</option>
                <option value="TypeScript">TypeScript</option>
                <option value="Python">Python</option>
                <option value="AI">AI</option>
                <option value="Web3">Web3</option>
                <option value="DevOps">DevOps</option>
                <option value="General">General</option>
              </select>

              <input 
                type="number" 
                placeholder="Min Amount" 
                className="search-input" 
                style={{ maxWidth: '140px' }}
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
              />
            </div>

            {/* Feed Grid */}
            {loadingBounties ? (
              <div className="loading-spinner-container">
                <div className="spinner"></div>
                <div className="loading-text">FETCHING_ISSUES...</div>
              </div>
            ) : bounties.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>NO_BOUNTIES_FOUND_MATCHING_CRITERIA</p>
            ) : (
              <div className="bounty-grid">
                {bounties.map((b) => (
                  <GlowCard key={b.id} onClick={() => setSelectedBounty(b)} style={{ cursor: 'pointer' }}>
                    <div className="card-top">
                      <div className="card-meta-column">
                        <span className="card-repo">{b.repository_full_name}</span>
                        <span className="card-issue-date">
                          Issued: {new Date(b.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <span className="card-amount-badge">
                        {b.parsed_amount > 0 ? `${b.parsed_amount} ${b.currency}` : 'Unparsed'}
                      </span>
                    </div>

                    <h3 className="card-title">{b.title}</h3>
                    
                    <p className="card-body">
                      {b.body ? b.body : 'No issue description text provided.'}
                    </p>

                    <div className="card-tags">
                      {b.topic_tags.split(',').map((tag, idx) => (
                        <span key={idx} className="tag-badge">{tag}</span>
                      ))}
                      {b.labels.split(',').slice(0, 3).map((lbl, idx) => (
                        <span key={idx} className="tag-badge" style={{ borderColor: 'rgba(255,255,255,0.02)', color: 'var(--text-muted)' }}>
                          {lbl}
                        </span>
                      ))}
                    </div>

                    <div className="card-actions">
                      {b.saved_bounty ? (
                        <button 
                          className="card-btn saved"
                          onClick={(e) => { e.stopPropagation(); unsaveMutation.mutate(b.id); }}
                        >
                          <Bookmark size={14} fill="currentColor" />
                          Saved
                        </button>
                      ) : (
                        <button 
                          className="card-btn"
                          onClick={(e) => { e.stopPropagation(); saveMutation.mutate({ bounty_issue_id: b.id, notes: '' }); }}
                        >
                          <Bookmark size={14} />
                          Save for Later
                        </button>
                      )}

                      <a 
                        href={b.html_url} 
                        target="_blank" 
                        rel="noreferrer" 
                        className="card-btn primary"
                        onClick={(e) => e.stopPropagation()}
                      >
                        GitHub <ExternalLink size={12} />
                      </a>
                    </div>
                  </GlowCard>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ==================================================================
            TAB 2: PIPELINE TRACKER
            ================================================================== */}
        {activeTab === 'saved' && (
          <div>
            <div className="scramble-title-container">
              <h1 className="scramble-title-shine">
                <ScrambleText text="PERSONAL_PIPELINE_TRACKER" />
              </h1>
            </div>

            <div className="pipeline-container">
              {/* Columns */}
              {['VIEWED', 'RESOLVING', 'SUBMITTED', 'APPROVED', 'PAID'].map((status) => {
                const columnBounties = bounties.filter(b => b.saved_bounty && b.bounty_progress?.status === status)
                
                return (
                  <div key={status} className="pipeline-column">
                    <div className="column-header">
                      <span className="column-title">{status}</span>
                      <span className="column-count">{columnBounties.length}</span>
                    </div>

                    {columnBounties.map(b => (
                      <div 
                        key={b.id} 
                        className="pipeline-card"
                        onClick={() => setSelectedBounty(b)}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="pipeline-card-repo">{b.repository_full_name}</div>
                        <div className="pipeline-card-date">
                          {new Date(b.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </div>
                        <div className="pipeline-card-title">{b.title}</div>
                        
                        <div className="pipeline-card-footer">
                          <span className="pipeline-card-amount">
                            {b.parsed_amount > 0 ? `${b.parsed_amount} ${b.currency}` : 'Unparsed'}
                          </span>
                          
                          <select 
                            className="pipeline-actions-select"
                            value={status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => { e.stopPropagation(); statusMutation.mutate({ id: b.id, status: e.target.value }); }}
                          >
                            <option value="VIEWED">Viewed</option>
                            <option value="RESOLVING">Resolving</option>
                            <option value="SUBMITTED">Submitted</option>
                            <option value="APPROVED">Approved</option>
                            <option value="PAID">Paid</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 3: ANALYTICS & STATS
            ================================================================== */}
        {activeTab === 'dashboard' && (
          <div>
            <div className="scramble-title-container">
              <h1 className="scramble-title-shine">
                <ScrambleText text="ANALYTICS_&_EARNINGS" />
              </h1>
            </div>

            {/* Stat Cards */}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">Total Saved Pipeline</div>
                <div className="stat-value">{stats.total_saved}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Active Attempting</div>
                <div className="stat-value">
                  {Object.entries(stats.funnel_stats)
                    .filter(([k]) => k === 'RESOLVING' || k === 'SUBMITTED')
                    .reduce((acc, [, val]) => acc + val, 0)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Paid Bounties</div>
                <div className="stat-value">{stats.funnel_stats['PAID'] || 0}</div>
              </div>
            </div>

            {/* Earnings grouped by currency */}
            <div className="funnel-container" style={{ marginBottom: '2rem' }}>
              <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '1.5rem', fontWeight: 700 }}>EARNED_BY_CURRENCY</h3>
              {Object.keys(stats.earnings_record).length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>NO_EARNINGS_RECORDED_YET_PAID_PIPELINE</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {Object.entries(stats.earnings_record).map(([currency, sum]) => (
                    <div key={currency} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '0.5rem', fontFamily: 'var(--font-mono)' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{currency}</span>
                      <span style={{ fontWeight: 'bold', color: 'var(--accent-blue)' }}>{sum.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Funnel Graph */}
            <div className="funnel-container">
              <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '2rem', fontWeight: 700 }}>PIPELINE_SUCCESS_FUNNEL</h3>
              
              <div className="funnel-bar-group">
                {['VIEWED', 'RESOLVING', 'SUBMITTED', 'APPROVED', 'PAID'].map((status) => {
                  const count = stats.funnel_stats[status] || 0
                  
                  // Calculate max count for scaling
                  const maxCount = Math.max(...Object.values(stats.funnel_stats), 1)
                  const percentWidth = (count / maxCount) * 100

                  return (
                    <div key={status} className="funnel-bar-row">
                      <div className="funnel-bar-label">{status}</div>
                      <div className="funnel-bar-track">
                        <div 
                          className="funnel-bar-fill"
                          style={{ width: `${percentWidth}%` }}
                        ></div>
                      </div>
                      <div className="funnel-bar-value">{count}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================
            TAB 4: SYSTEM SETTINGS
            ================================================================== */}
        {activeTab === 'settings' && (
          <div>
            <div className="scramble-title-container">
              <h1 className="scramble-title-shine">
                <ScrambleText text="CONTROL_PANEL_SETTINGS" />
              </h1>
            </div>

            {settings?.last_synced_at && (
              <div style={{
                marginBottom: '1.5rem',
                fontSize: '0.85rem',
                color: '#86868b',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                padding: '0.5rem 1rem',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.05)'
              }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', display: 'inline-block' }}></span>
                Last checked for new GitHub bounties: {new Date(settings.last_synced_at).toLocaleString()}
              </div>
            )}

            <div className="settings-panel">
              <form onSubmit={handleSettingsSubmit}>
                
                <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '1.5rem', color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '0.5rem' }}>GitHub Integration</h3>
                
                <div className="form-group">
                  <label className="form-label">Personal Access Token (PAT)</label>
                  <input 
                    type="password" 
                    className="form-input" 
                    value={formSettings.github_token}
                    onChange={(e) => setFormSettings({ ...formSettings, github_token: e.target.value })}
                    placeholder="ghp_xxxxxxxxxxxx"
                  />
                  <span className="form-hint">Used server-side to fetch bounty issues and bypass standard GitHub API rate limits. Requires public_repo access.</span>
                </div>

                <h3 style={{ fontFamily: 'var(--font-display)', margin: '2.5rem 0 1.5rem 0', color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '0.5rem' }}>Notification Settings</h3>

                <div className="form-group">
                  <label className="form-label">Fallback Subscriber Email</label>
                  <input 
                    type="email" 
                    className="form-input" 
                    value={formSettings.email}
                    onChange={(e) => setFormSettings({ ...formSettings, email: e.target.value })}
                    placeholder="your-email@gmail.com"
                  />
                  <span className="form-hint">Receiver address if no team subscribers are added.</span>
                </div>

                <div className="form-group" style={{ marginTop: '2rem' }}>
                  <label className="form-label" style={{ color: 'var(--color-electric-mint)' }}>Add Team Subscriber</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input 
                      type="email" 
                      className="form-input" 
                      value={newSubEmail}
                      onChange={(e) => setNewSubEmail(e.target.value)}
                      placeholder="team-member@company.com"
                      style={{ flex: 1 }}
                    />
                    <button 
                      type="button" 
                      className="rolling-btn" 
                      onClick={() => {
                        if (newSubEmail.trim()) {
                          addSubMutation.mutate(newSubEmail.trim());
                        }
                      }}
                      style={{ height: '46px', borderRadius: '8px' }}
                    >
                      <span className="rolling-btn-text" data-text="Add Email">Add Email</span>
                    </button>
                  </div>
                  <span className="form-hint">Enter a team member's email address to add them to the email list.</span>
                </div>

                {subscribers.length > 0 && (
                  <div style={{
                    marginTop: '1.5rem',
                    marginBottom: '2rem',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid rgba(255, 255, 255, 0.05)',
                    borderRadius: '8px',
                    padding: '1rem'
                  }}>
                    <h4 style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Team Subscribers ({subscribers.length})</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {subscribers.map((sub) => (
                        <div key={sub.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
                          <span style={{ fontSize: '0.9rem', color: '#f5f5f7' }}>{sub.email}</span>
                          <button 
                            type="button" 
                            onClick={() => deleteSubMutation.mutate(sub.id)}
                            style={{ background: 'transparent', border: 'none', color: '#ff4d4d', cursor: 'pointer', fontSize: '1.1rem', fontWeight: 'bold' }}
                            title="Remove subscriber"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Notification Mode</label>
                  <select
                    className="form-input"
                    value={formSettings.notification_mode}
                    onChange={(e) => setFormSettings({ ...formSettings, notification_mode: e.target.value })}
                    style={{ background: '#0d0e15', cursor: 'pointer' }}
                  >
                    <option value="both">Both (Real-time Alerts & Daily Digest)</option>
                    <option value="instant">Real-time Email Alerts Only</option>
                    <option value="digest">Daily Digest Email Only</option>
                  </select>
                  <span className="form-hint">How and when you want to receive emails about new matching bounties.</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Bounty Checking Frequency</label>
                  <select
                    className="form-input"
                    value={formSettings.sync_interval_mins}
                    onChange={(e) => setFormSettings({ ...formSettings, sync_interval_mins: parseInt(e.target.value) || 60 })}
                    style={{ background: '#0d0e15', cursor: 'pointer' }}
                  >
                    <option value="15">Every 15 Minutes</option>
                    <option value="30">Every 30 Minutes</option>
                    <option value="60">Every Hour</option>
                    <option value="180">Every 3 Hours</option>
                    <option value="360">Every 6 Hours</option>
                    <option value="720">Every 12 Hours</option>
                    <option value="1440">Every 24 Hours</option>
                  </select>
                  <span className="form-hint">How often the system queries GitHub to discover new matching bounty opportunities.</span>
                </div>

                {(formSettings.notification_mode === 'instant' || formSettings.notification_mode === 'both') && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div className="form-group">
                      <label className="form-label">Quiet Hours Start</label>
                      <input 
                        type="time" 
                        className="form-input" 
                        value={formSettings.quiet_hours_start}
                        onChange={(e) => setFormSettings({ ...formSettings, quiet_hours_start: e.target.value })}
                      />
                      <span className="form-hint">Do not send instant alerts starting at this time.</span>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Quiet Hours End</label>
                      <input 
                        type="time" 
                        className="form-input" 
                        value={formSettings.quiet_hours_end}
                        onChange={(e) => setFormSettings({ ...formSettings, quiet_hours_end: e.target.value })}
                      />
                      <span className="form-hint">Resume sending instant alerts after this time.</span>
                    </div>
                  </div>
                )}

                {(formSettings.notification_mode === 'digest' || formSettings.notification_mode === 'both') && (
                  <div className="form-group">
                    <label className="form-label">Digest Scheduled Time</label>
                    <input 
                      type="time" 
                      className="form-input" 
                      value={formSettings.digest_time}
                      onChange={(e) => setFormSettings({ ...formSettings, digest_time: e.target.value })}
                    />
                    <span className="form-hint">Choose the time (24h format) to trigger your daily digest email.</span>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Min Bounty Amount Threshold</label>
                  <input 
                    type="number" 
                    className="form-input" 
                    value={formSettings.min_bounty_amount}
                    onChange={(e) => setFormSettings({ ...formSettings, min_bounty_amount: parseFloat(e.target.value) || 0 })}
                  />
                  <span className="form-hint">Only issues exceeding this parsed amount will be summarized or notified.</span>
                </div>

                <div className="form-group">
                  <label className="form-label">Filter Languages (Comma separated)</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={formSettings.filter_languages}
                    onChange={(e) => setFormSettings({ ...formSettings, filter_languages: e.target.value })}
                    placeholder="Go,Rust,TypeScript,AI"
                  />
                  <span className="form-hint">Filter tags for digest/alert matching. Case-insensitive.</span>
                </div>

                <h3 style={{ fontFamily: 'var(--font-display)', margin: '2.5rem 0 1.5rem 0', color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '0.5rem' }}>SMTP Mail Server</h3>

                <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: '1rem' }}>
                  <div className="form-group">
                    <label className="form-label">SMTP Host</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={formSettings.smtp_host}
                      onChange={(e) => setFormSettings({ ...formSettings, smtp_host: e.target.value })}
                      placeholder="smtp.gmail.com"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">SMTP Port</label>
                    <input 
                      type="number" 
                      className="form-input" 
                      value={formSettings.smtp_port}
                      onChange={(e) => setFormSettings({ ...formSettings, smtp_port: parseInt(e.target.value) || 587 })}
                      placeholder="587"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">SMTP Username</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={formSettings.smtp_user}
                    onChange={(e) => setFormSettings({ ...formSettings, smtp_user: e.target.value })}
                    placeholder="your-email@gmail.com"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">SMTP Password</label>
                  <input 
                    type="password" 
                    className="form-input" 
                    value={formSettings.smtp_pass}
                    onChange={(e) => setFormSettings({ ...formSettings, smtp_pass: e.target.value })}
                    placeholder="••••••••••••••••"
                  />
                  <span className="form-hint">Provide an App Password if using Gmail. Do not share your primary account password.</span>
                </div>

                <div className="settings-btn-row" style={{ display: 'flex', gap: '1rem', marginTop: '2.5rem' }}>
                  <button 
                    type="button" 
                    className="rolling-btn" 
                    onClick={handleTestEmail}
                    disabled={testEmailLoading}
                    style={{
                      backgroundColor: 'transparent',
                      borderColor: 'rgba(255,255,255,0.15)',
                      color: 'var(--color-paper-white)'
                    }}
                  >
                    <span className="rolling-btn-text" data-text={testEmailLoading ? "Sending..." : "Test SMTP Config"}>
                      {testEmailLoading ? "Sending..." : "Test SMTP Config"}
                    </span>
                  </button>

                  <button type="submit" className="rolling-btn">
                    <span className="rolling-btn-text" data-text="Save Configuration">
                      Save Settings
                    </span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </main>

      {/* Detailed Modal view */}
      {selectedBounty && (
        <div className="modal-overlay" onClick={() => setSelectedBounty(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setSelectedBounty(null)}>×</button>
            
            <div className="modal-header">
              <span className="modal-repo">{selectedBounty.repository_full_name}</span>
              <span className="modal-date">
                Issued: {new Date(selectedBounty.created_at).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' })}
              </span>
            </div>

            <h2 className="modal-title">{selectedBounty.title}</h2>
            
            <div className="modal-meta-row">
              <div className="modal-meta-item">
                <span className="modal-meta-label">REWARD</span>
                <span className="modal-meta-val highlight-mint">
                  {selectedBounty.parsed_amount > 0 ? `${selectedBounty.parsed_amount} ${selectedBounty.currency}` : 'Unparsed'}
                </span>
              </div>
              {selectedBounty.bounty_progress && (
                <div className="modal-meta-item">
                  <span className="modal-meta-label">PIPELINE STATUS</span>
                  <span className="modal-meta-val status-pill">{selectedBounty.bounty_progress.status}</span>
                </div>
              )}
            </div>

            <div className="modal-tags">
              {selectedBounty.topic_tags.split(',').map((tag, idx) => (
                <span key={idx} className="tag-badge">{tag}</span>
              ))}
            </div>

            <div className="modal-divider"></div>

            <div className="modal-body-container">
              <div className="modal-body-title">Bounty Description</div>
              <div className="modal-body-text">
                {selectedBounty.body ? selectedBounty.body : 'No description provided.'}
              </div>
            </div>

            <div className="modal-actions-row">
              <a 
                href={selectedBounty.html_url} 
                target="_blank" 
                rel="noreferrer" 
                className="rolling-btn modal-btn-main"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="rolling-btn-text" data-text="Open GitHub Issue">Open GitHub Issue</span>
              </a>
              
              {selectedBounty.saved_bounty ? (
                <button 
                  className="card-btn saved modal-btn-sec"
                  onClick={(e) => {
                    e.stopPropagation();
                    unsaveMutation.mutate(selectedBounty.id);
                    setSelectedBounty({ ...selectedBounty, saved_bounty: null });
                  }}
                >
                  <Bookmark size={14} fill="currentColor" /> Saved
                </button>
              ) : (
                <button 
                  className="card-btn modal-btn-sec"
                  onClick={(e) => {
                    e.stopPropagation();
                    saveMutation.mutate({ bounty_issue_id: selectedBounty.id, notes: '' });
                    setSelectedBounty({ ...selectedBounty, saved_bounty: { notes: '' } });
                  }}
                >
                  <Bookmark size={14} /> Save for Later
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
