package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/joho/godotenv"
	"github.com/rs/cors"
)

func main() {
	// Load environment variables (optional)
	_ = godotenv.Load()

	// Initialize SQLite database
	dbPath := "bounties.db"
	if envDb := os.Getenv("DATABASE_URL"); envDb != "" {
		dbPath = envDb
	}
	log.Printf("Initializing database at: %s", dbPath)
	if err := InitDB(dbPath); err != nil {
		log.Fatalf("Database initialization failed: %v", err)
	}

	// Initialize UserSetting with environment variables if available
	initEnvSettings()

	// Start Background Cron Ticker (every 24 hours)
	StartCronScheduler()

	// Setup Router
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// API Routes
	r.Get("/api/bounties", handleGetBounties)
	r.Post("/api/bounties/sync", handleManualSync)
	r.Post("/api/bounties/save", handleSaveBounty)
	r.Post("/api/bounties/unsave", handleUnsaveBounty)
	r.Post("/api/bounties/{id}/status", handleUpdateStatus)
	r.Get("/api/dashboard", handleGetDashboardStats)
	r.Get("/api/settings", handleGetSettings)
	r.Post("/api/settings", handleUpdateSettings)
	r.Post("/api/settings/test-email", handleTestEmail)
	r.Get("/api/subscribers", handleGetSubscribers)
	r.Post("/api/subscribers", handleAddSubscriber)
	r.Delete("/api/subscribers/{id}", handleDeleteSubscriber)

	// Configure CORS
	corsHandler := cors.New(cors.Options{
		AllowedOrigins:   []string{"http://localhost:5173", "http://127.0.0.1:5173"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Content-Type", "Content-Length", "Accept-Encoding", "X-CSRF-Token", "Authorization"},
		AllowCredentials: true,
	}).Handler(r)

	port := "8080"
	if envPort := os.Getenv("PORT"); envPort != "" {
		port = envPort
	}

	log.Printf("Bounty Control Center API running on port %s", port)
	if err := http.ListenAndServe(":"+port, corsHandler); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// initEnvSettings loads initial values from environment into database on first run
func initEnvSettings() {
	var settings UserSetting
	if err := DB.First(&settings).Error; err == nil {
		// Update only if DB settings are blank but env is provided
		updated := false
		if settings.GithubToken == "" && os.Getenv("GITHUB_PAT") != "" {
			settings.GithubToken = os.Getenv("GITHUB_PAT")
			updated = true
		}
		if settings.Email == "" && os.Getenv("EMAIL_SUBSCRIBER") != "" {
			settings.Email = os.Getenv("EMAIL_SUBSCRIBER")
			updated = true
		}
		if settings.SMTPHost == "" && os.Getenv("SMTP_HOST") != "" {
			settings.SMTPHost = os.Getenv("SMTP_HOST")
			settings.SMTPUser = os.Getenv("SMTP_USER")
			settings.SMTPPass = os.Getenv("SMTP_PASS")
			if port, err := strconv.Atoi(os.Getenv("SMTP_PORT")); err == nil {
				settings.SMTPPort = port
			} else {
				settings.SMTPPort = 587
			}
			updated = true
		}
		if updated {
			DB.Save(&settings)
			log.Println("Database settings updated from environment variables.")
		}
	}
}

// --------------------------------------------------------------------------
// Route Handlers
// --------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func handleGetBounties(w http.ResponseWriter, r *http.Request) {
	// Query parameters
	search := r.URL.Query().Get("search")
	language := r.URL.Query().Get("language")
	minAmtStr := r.URL.Query().Get("min_amount")
	savedOnly := r.URL.Query().Get("saved")

	var issues []BountyIssue
	query := DB.Model(&BountyIssue{})

	// Preload SavedBounty and BountyProgress relations
	query = query.Preload("SavedBounty").Preload("BountyProgress")

	if search != "" {
		query = query.Where("title LIKE ? OR body LIKE ?", "%"+search+"%", "%"+search+"%")
	}

	if language != "" && language != "All" {
		query = query.Where("topic_tags LIKE ?", "%"+language+"%")
	}

	if minAmtStr != "" {
		if minAmt, err := strconv.ParseFloat(minAmtStr, 64); err == nil {
			query = query.Where("parsed_amount >= ?", minAmt)
		}
	}

	// Filter by saved state
	if savedOnly == "true" {
		query = query.Joins("INNER JOIN saved_bounties ON saved_bounties.bounty_issue_id = bounty_issues.id")
	}

	// Order by creation date
	err := query.Order("created_at DESC").Find(&issues).Error
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, issues)
}

func handleManualSync(w http.ResponseWriter, r *http.Request) {
	log.Println("Manual sync requested...")
	err := SyncAndSendDigest()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Bounties synced successfully"})
}

type SavePayload struct {
	BountyIssueID uint   `json:"bounty_issue_id"`
	Notes         string `json:"notes"`
}

func handleSaveBounty(w http.ResponseWriter, r *http.Request) {
	var payload SavePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	saved := SavedBounty{
		BountyIssueID: payload.BountyIssueID,
		SavedAt:       time.Now(),
		Notes:         payload.Notes,
	}

	// Save or update notes
	err := DB.Where(SavedBounty{BountyIssueID: payload.BountyIssueID}).
		Assign(SavedBounty{Notes: payload.Notes, SavedAt: time.Now()}).
		FirstOrCreate(&saved).Error

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Also auto-create a viewed progress status if not already present
	progress := BountyProgress{
		BountyIssueID: payload.BountyIssueID,
		Status:        "VIEWED",
		LastUpdatedAt: time.Now(),
	}
	DB.Where(BountyProgress{BountyIssueID: payload.BountyIssueID}).FirstOrCreate(&progress)

	writeJSON(w, http.StatusOK, saved)
}

func handleUnsaveBounty(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		BountyIssueID uint `json:"bounty_issue_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Delete from SavedBounty
	err := DB.Where("bounty_issue_id = ?", payload.BountyIssueID).Delete(&SavedBounty{}).Error
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Delete progress tracking
	DB.Where("bounty_issue_id = ?", payload.BountyIssueID).Delete(&BountyProgress{})

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type StatusPayload struct {
	Status string `json:"status"`
}

func handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	bountyID, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var payload StatusPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	status := strings.ToUpper(payload.Status)
	validStatuses := map[string]bool{"VIEWED": true, "RESOLVING": true, "SUBMITTED": true, "APPROVED": true, "PAID": true}
	if !validStatuses[status] {
		http.Error(w, "Invalid status enum value", http.StatusBadRequest)
		return
	}

	progress := BountyProgress{
		BountyIssueID: uint(bountyID),
		Status:        status,
		LastUpdatedAt: time.Now(),
	}

	err = DB.Where(BountyProgress{BountyIssueID: uint(bountyID)}).
		Assign(BountyProgress{Status: status, LastUpdatedAt: time.Now()}).
		FirstOrCreate(&progress).Error

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// If marked PAID, auto-create EarningsRecord using the parsed amount/currency from BountyIssue
	if status == "PAID" {
		var issue BountyIssue
		if err := DB.First(&issue, bountyID).Error; err == nil && issue.ParsedAmount > 0 {
			earning := EarningsRecord{
				BountyIssueID: issue.ID,
				Amount:        issue.ParsedAmount,
				Currency:      issue.Currency,
				PaidAt:        time.Now(),
			}
			DB.Where(EarningsRecord{BountyIssueID: issue.ID}).Assign(EarningsRecord{
				Amount:   issue.ParsedAmount,
				Currency: issue.Currency,
				PaidAt:   time.Now(),
			}).FirstOrCreate(&earning)
		}
	} else {
		// If changed from PAID to something else, remove EarningsRecord
		DB.Where("bounty_issue_id = ?", bountyID).Delete(&EarningsRecord{})
	}

	writeJSON(w, http.StatusOK, progress)
}

type DashboardStats struct {
	TotalSaved      int64              `json:"total_saved"`
	FunnelStats     map[string]int64   `json:"funnel_stats"`
	EarningsRecord  map[string]float64 `json:"earnings_record"`
}

func handleGetDashboardStats(w http.ResponseWriter, r *http.Request) {
	var stats DashboardStats
	stats.FunnelStats = map[string]int64{"VIEWED": 0, "RESOLVING": 0, "SUBMITTED": 0, "APPROVED": 0, "PAID": 0}
	stats.EarningsRecord = make(map[string]float64)

	// Total saved count
	DB.Model(&SavedBounty{}).Count(&stats.TotalSaved)

	// Pipeline counts
	var progresses []BountyProgress
	DB.Find(&progresses)
	for _, p := range progresses {
		stats.FunnelStats[p.Status]++
	}

	// Earnings by currency
	type CurrencySum struct {
		Currency string
		Total    float64
	}
	var sums []CurrencySum
	DB.Model(&EarningsRecord{}).Select("currency, sum(amount) as total").Group("currency").Scan(&sums)

	for _, s := range sums {
		if s.Currency != "" {
			stats.EarningsRecord[s.Currency] = s.Total
		}
	}

	writeJSON(w, http.StatusOK, stats)
}

func handleGetSettings(w http.ResponseWriter, r *http.Request) {
	var settings UserSetting
	if err := DB.First(&settings).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var payload UserSetting
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var existing UserSetting
	if err := DB.First(&existing).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Update fields
	existing.GithubToken = payload.GithubToken
	existing.Email = payload.Email
	existing.MinBountyAmount = payload.MinBountyAmount
	existing.FilterLanguages = payload.FilterLanguages
	existing.SMTPHost = payload.SMTPHost
	existing.SMTPPort = payload.SMTPPort
	existing.SMTPUser = payload.SMTPUser
	existing.SMTPPass = payload.SMTPPass
	existing.DigestTime = payload.DigestTime
	existing.NotificationMode = payload.NotificationMode
	existing.SyncIntervalMins = payload.SyncIntervalMins
	existing.QuietHoursStart = payload.QuietHoursStart
	existing.QuietHoursEnd = payload.QuietHoursEnd

	if err := DB.Save(&existing).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, existing)
}

func handleTestEmail(w http.ResponseWriter, r *http.Request) {
	var settings UserSetting
	if err := DB.First(&settings).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if settings.Email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Please configure a subscriber email address first."})
		return
	}

	dummyBounties := []BountyIssue{
		{
			Title:              "Demo Bounty: Implement Realtime Mail Notifications",
			RepositoryFullName: "aakaru/bountyhub",
			ParsedAmount:       500,
			Currency:           "USD",
			TopicTags:          "Go,React,TypeScript",
			HTMLURL:            "https://github.com/aakaru/bountyhub",
		},
	}

	subject := "BountyHub Alert: SMTP Test Notification"
	heading := "SMTP Connection Success!"
	intro := "This is a test notification confirming that your mail settings are properly configured and working."

	err := SendEmailNotification(settings, dummyBounties, subject, heading, intro)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "success", "message": "Test email sent successfully!"})
}

func handleGetSubscribers(w http.ResponseWriter, r *http.Request) {
	var subs []Subscriber
	if err := DB.Order("created_at DESC").Find(&subs).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, subs)
}

type SubscriberPayload struct {
	Email string `json:"email"`
}

func handleAddSubscriber(w http.ResponseWriter, r *http.Request) {
	var payload SubscriberPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	email := strings.TrimSpace(payload.Email)
	if email == "" {
		http.Error(w, "Email is required", http.StatusBadRequest)
		return
	}

	sub := Subscriber{
		Email:     email,
		CreatedAt: time.Now(),
	}

	if err := DB.Create(&sub).Error; err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Email already subscribed"})
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, sub)
}

func handleDeleteSubscriber(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := DB.Delete(&Subscriber{}, id).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
