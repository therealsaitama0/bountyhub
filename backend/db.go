package main

import (
	"os"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

var DB *gorm.DB

// GORM Schemas
type BountyIssue struct {
	ID                 uint           `gorm:"primaryKey" json:"id"`
	GithubIssueID      int64          `gorm:"uniqueIndex" json:"github_issue_id"`
	RepositoryFullName string         `json:"repository_full_name"`
	Title              string         `json:"title"`
	Body               string         `json:"body"`
	Labels             string         `json:"labels"` // Store as comma-separated values
	HTMLURL            string         `json:"html_url"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
	ParsedAmount       float64        `json:"parsed_amount"`
	Currency           string         `json:"currency"`
	TopicTags          string         `json:"topic_tags"` // Store as comma-separated tags
	SavedBounty        *SavedBounty   `json:"saved_bounty,omitempty"`
	BountyProgress     *BountyProgress `json:"bounty_progress,omitempty"`
}

type SavedBounty struct {
	ID            uint      `gorm:"primaryKey" json:"id"`
	BountyIssueID uint      `gorm:"uniqueIndex" json:"bounty_issue_id"`
	SavedAt       time.Time `json:"saved_at"`
	Notes         string    `json:"notes"`
}

type BountyProgress struct {
	ID            uint      `gorm:"primaryKey" json:"id"`
	BountyIssueID uint      `gorm:"uniqueIndex" json:"bounty_issue_id"`
	Status        string    `json:"status"` // VIEWED, RESOLVING, SUBMITTED, APPROVED, PAID
	LastUpdatedAt time.Time `json:"last_updated_at"`
}

type EarningsRecord struct {
	ID            uint      `gorm:"primaryKey" json:"id"`
	BountyIssueID uint      `gorm:"uniqueIndex" json:"bounty_issue_id"`
	Amount        float64   `json:"amount"`
	Currency      string    `json:"currency"`
	PaidAt        time.Time `json:"paid_at"`
}

type UserSetting struct {
	ID               uint      `gorm:"primaryKey" json:"id"`
	GithubToken      string    `json:"github_token"`
	Email            string    `json:"email"`
	MinBountyAmount  float64   `json:"min_bounty_amount"`
	FilterLanguages  string    `json:"filter_languages"` // Comma-separated: "Go,Rust,TypeScript"
	SMTPHost         string    `json:"smtp_host"`
	SMTPPort         int       `json:"smtp_port"`
	SMTPUser         string    `json:"smtp_user"`
	SMTPPass         string    `json:"smtp_pass"`
	DigestTime       string    `json:"digest_time"`        // "09:00"
	NotificationMode string    `json:"notification_mode"` // "instant", "digest", "both"
	SyncIntervalMins int       `json:"sync_interval_mins"` // e.g. 30, 60, 120
	QuietHoursStart  string    `json:"quiet_hours_start"` // "22:00"
	QuietHoursEnd    string    `json:"quiet_hours_end"`   // "08:00"
	LastSyncedAt     time.Time `json:"last_synced_at"`
}

type Subscriber struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Email     string    `gorm:"uniqueIndex" json:"email"`
	CreatedAt time.Time `json:"created_at"`
}

func InitDB(dbPath string) error {
	var err error
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL != "" {
		DB, err = gorm.Open(postgres.Open(dbURL), &gorm.Config{})
	} else {
		DB, err = gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	}
	if err != nil {
		return err
	}

	// Auto migrate tables
	err = DB.AutoMigrate(
		&BountyIssue{},
		&SavedBounty{},
		&BountyProgress{},
		&EarningsRecord{},
		&UserSetting{},
		&Subscriber{},
	)
	if err != nil {
		return err
	}

	// Create default user setting row if empty
	var count int64
	DB.Model(&UserSetting{}).Count(&count)
	if count == 0 {
		defaultSettings := UserSetting{
			MinBountyAmount:  0.0,
			FilterLanguages:  "Go,Rust,TypeScript,Python",
			DigestTime:       "09:00",
			NotificationMode: "both",
			SyncIntervalMins: 60,
			QuietHoursStart:  "22:00",
			QuietHoursEnd:    "08:00",
		}
		DB.Create(&defaultSettings)
	}

	// Seed subscribers table with existing settings email if empty
	var subCount int64
	DB.Model(&Subscriber{}).Count(&subCount)
	if subCount == 0 {
		var settings UserSetting
		if err := DB.First(&settings).Error; err == nil && settings.Email != "" {
			DB.Create(&Subscriber{
				Email:     settings.Email,
				CreatedAt: time.Now(),
			})
		}
	}

	return nil
}
