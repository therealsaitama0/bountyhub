package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

// StartCronScheduler runs a background goroutine syncing bounties and sending notifications/digests
func StartCronScheduler() {
	// Sync immediately on startup in a separate goroutine
	go func() {
		log.Println("Running startup bounty sync...")
		var settings UserSetting
		if err := DB.First(&settings).Error; err == nil {
			_, err := SyncBounties(&settings)
			if err != nil {
				log.Printf("Startup sync error: %v", err)
			}
		}
	}()

	// Check settings/times every 1 minute
	ticker := time.NewTicker(1 * time.Minute)
	var lastSentDay string
	go func() {
		for range ticker.C {
			var settings UserSetting
			if err := DB.First(&settings).Error; err != nil {
				continue
			}

			now := time.Now()

			// 1. Check if it's time to Sync from GitHub
			intervalMins := settings.SyncIntervalMins
			if intervalMins <= 0 {
				intervalMins = 60 // Default to 60 minutes if invalid
			}
			
			// Sync if last synced is longer ago than interval (or if never synced before)
			if settings.LastSyncedAt.IsZero() || now.Sub(settings.LastSyncedAt) >= (time.Duration(intervalMins)*time.Minute) {
				log.Printf("Sync interval (%d mins) elapsed. Starting sync...", intervalMins)
				newBounties, err := SyncBounties(&settings)
				if err != nil {
					log.Printf("Periodic sync error: %v", err)
				} else if len(newBounties) > 0 {
					// Check if we should send instant notifications
					if settings.NotificationMode == "instant" || settings.NotificationMode == "both" {
						if IsInQuietHours(now, settings.QuietHoursStart, settings.QuietHoursEnd) {
							log.Printf("Found %d new bounties, but quiet hours are active (%s - %s). Suppressing instant notification.", len(newBounties), settings.QuietHoursStart, settings.QuietHoursEnd)
						} else {
							log.Printf("Found %d new bounties. Sending instant notification...", len(newBounties))
							subject := fmt.Sprintf("BountyHub Alert: %d New Bounty/Bounties Found", len(newBounties))
							heading := "Instant Bounty Alert"
							intro := fmt.Sprintf("We found <strong>%d</strong> new bounties matching your stack preferences just now.", len(newBounties))
							err := SendEmailNotification(settings, newBounties, subject, heading, intro)
							if err != nil {
								log.Printf("Failed to send instant notification: %v", err)
							}
						}
					}
				}
			}

			// 2. Check if it's time to send Daily Digest
			digestTime := settings.DigestTime
			if digestTime == "" {
				digestTime = "09:00"
			}

			currentTimeStr := now.Format("15:04")
			currentDayStr := now.Format("2006-01-02")

			if currentTimeStr == digestTime && lastSentDay != currentDayStr {
				if settings.NotificationMode == "digest" || settings.NotificationMode == "both" {
					log.Printf("Scheduled digest time reached (%s). Accumulating digest...", digestTime)
					
					// Find all bounties matching user filters created/added in the last 24 hours
					var issues []BountyIssue
					yesterday := now.Add(-24 * time.Hour)
					err := DB.Where("created_at > ?", yesterday).Order("created_at DESC").Find(&issues).Error
					if err != nil {
						log.Printf("Failed to fetch digest issues: %v", err)
						continue
					}

					var matchingIssues []BountyIssue
					for _, iss := range issues {
						if IsBountyMatch(iss, settings) {
							matchingIssues = append(matchingIssues, iss)
						}
					}

					if len(matchingIssues) > 0 {
						subject := fmt.Sprintf("BountyHub Digest: %d New Bounties Discovered Today", len(matchingIssues))
						heading := "Daily Bounty Digest"
						intro := fmt.Sprintf("We summarized <strong>%d</strong> matching bounties for you today.", len(matchingIssues))
						err := SendEmailNotification(settings, matchingIssues, subject, heading, intro)
						if err != nil {
							log.Printf("Failed to send digest email: %v", err)
						} else {
							lastSentDay = currentDayStr
						}
					} else {
						log.Println("No new bounties found in last 24h for daily digest. Skipping digest email.")
						lastSentDay = currentDayStr // Prevent re-triggering within the same minute
					}
				}
			}
		}
	}()
}

// SyncBounties fetches latest bounties from GitHub and caches them in SQLite
func SyncBounties(settings *UserSetting) ([]BountyIssue, error) {
	token := settings.GithubToken
	issues, err := FetchGitHubBounties(token)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch from github: %w", err)
	}

	var newBounties []BountyIssue
	for _, iss := range issues {
		var existing BountyIssue
		res := DB.Where("github_issue_id = ?", iss.GithubIssueID).First(&existing)
		if res.Error != nil {
			// Brand new bounty
			if err := DB.Create(&iss).Error; err == nil {
				if IsBountyMatch(iss, *settings) {
					newBounties = append(newBounties, iss)
				}
			}
		} else {
			// Update existing bounty cache details
			DB.Model(&existing).Updates(BountyIssue{
				Title:        iss.Title,
				Body:         iss.Body,
				UpdatedAt:    iss.UpdatedAt,
				ParsedAmount: iss.ParsedAmount,
				Currency:     iss.Currency,
				TopicTags:    iss.TopicTags,
			})
		}
	}

	// Update last synced time
	settings.LastSyncedAt = time.Now()
	DB.Save(settings)

	log.Printf("Sync completed. Checked %d issues, found %d new ones matching user filters.", len(issues), len(newBounties))
	return newBounties, nil
}

// SyncAndSendDigest forces a sync and triggers a digest immediately (manual trigger)
func SyncAndSendDigest() error {
	var settings UserSetting
	if err := DB.First(&settings).Error; err != nil {
		return fmt.Errorf("failed to fetch user settings: %w", err)
	}

	newBounties, err := SyncBounties(&settings)
	if err != nil {
		return err
	}

	// For manual sync, send email immediately if any new ones found
	if len(newBounties) > 0 && settings.Email != "" && (settings.SMTPHost != "" || os.Getenv("SMTP_HOST") != "") {
		subject := fmt.Sprintf("BountyHub Sync: %d New Bounties Found", len(newBounties))
		heading := "Manual Sync Alert"
		intro := fmt.Sprintf("We found <strong>%d</strong> new bounties matching your stack preferences during manual sync.", len(newBounties))
		return SendEmailNotification(settings, newBounties, subject, heading, intro)
	}

	return nil
}

// IsInQuietHours checks if current time falls within user quiet hours (HH:MM format)
func IsInQuietHours(now time.Time, startStr, endStr string) bool {
	if startStr == "" || endStr == "" {
		return false
	}
	t, err := time.Parse("15:04", now.Format("15:04"))
	if err != nil {
		return false
	}
	start, err := time.Parse("15:04", startStr)
	if err != nil {
		return false
	}
	end, err := time.Parse("15:04", endStr)
	if err != nil {
		return false
	}

	if start.Before(end) {
		return !t.Before(start) && !t.After(end)
	} else {
		// Overlap midnight (e.g. 22:00 to 08:00)
		return !t.Before(start) || !t.After(end)
	}
}

// IsBountyMatch filters bounties based on user settings
func IsBountyMatch(bounty BountyIssue, settings UserSetting) bool {
	// Min amount filter
	if bounty.ParsedAmount > 0 && bounty.ParsedAmount < settings.MinBountyAmount {
		return false
	}

	// Language tags filter
	if settings.FilterLanguages != "" {
		languages := strings.Split(strings.ToLower(settings.FilterLanguages), ",")
		bountyTags := strings.ToLower(bounty.TopicTags)
		
		match := false
		for _, lang := range languages {
			lang = strings.TrimSpace(lang)
			if lang == "" {
				continue
			}
			if strings.Contains(bountyTags, lang) {
				match = true
				break
			}
		}
		if !match && bounty.TopicTags != "General" {
			return false
		}
	}

	return true
}

// SendEmailNotification constructs and sends HTML email
// SendEmailNotification constructs and sends HTML email to all registered subscribers
func SendEmailNotification(settings UserSetting, bounties []BountyIssue, subject string, heading string, introText string) error {
	// Build HTML Body
	var bodyBuilder strings.Builder
	bodyBuilder.WriteString("<html><body style=\"font-family: sans-serif; background-color: #0d0e15; color: #f5f5f7; padding: 20px;\">")
	bodyBuilder.WriteString(fmt.Sprintf("<h1 style=\"color: #4d65ff; border-bottom: 2px solid #1a1c29; padding-bottom: 10px;\">%s</h1>", heading))
	bodyBuilder.WriteString(fmt.Sprintf("<p style=\"color: #86868b;\">%s</p><br/>", introText))

	for _, b := range bounties {
		bodyBuilder.WriteString("<div style=\"background-color: #12131e; border: 1px solid #1f2136; border-radius: 8px; padding: 15px; margin-bottom: 15px;\">")
		bodyBuilder.WriteString("<table width=\"100%\" style=\"border-collapse: collapse;\"><tr>")
		bodyBuilder.WriteString(fmt.Sprintf("<td><h3 style=\"margin: 0; color: #ffffff;\">%s</h3></td>", b.Title))
		
		// Highlight reward
		rewardText := "Unparsed"
		if b.ParsedAmount > 0 {
			rewardText = fmt.Sprintf("%.2f %s", b.ParsedAmount, b.Currency)
		}
		bodyBuilder.WriteString(fmt.Sprintf("<td align=\"right\"><span style=\"background-color: rgba(77, 101, 255, 0.2); border: 1px solid #4d65ff; color: #ffffff; padding: 4px 8px; border-radius: 4px; font-weight: bold;\">%s</span></td>", rewardText))
		
		bodyBuilder.WriteString("</tr></table>")
		bodyBuilder.WriteString(fmt.Sprintf("<p style=\"margin: 8px 0; color: #86868b; font-size: 0.85em;\">Repository: <strong>%s</strong></p>", b.RepositoryFullName))
		
		// Display tags
		tags := strings.Split(b.TopicTags, ",")
		bodyBuilder.WriteString("<p style=\"margin: 8px 0;\">")
		for _, tag := range tags {
			bodyBuilder.WriteString(fmt.Sprintf("<span style=\"background-color: #1b1c2a; color: #86868b; font-size: 0.8em; padding: 2px 6px; margin-right: 5px; border-radius: 3px;\">%s</span>", tag))
		}
		bodyBuilder.WriteString("</p>")

		bodyBuilder.WriteString(fmt.Sprintf("<p style=\"margin-top: 15px;\"><a href=\"%s\" style=\"color: #4d65ff; text-decoration: none; font-weight: bold;\">View on GitHub →</a></p>", b.HTMLURL))
		bodyBuilder.WriteString("</div>")
	}

	bodyBuilder.WriteString("<hr style=\"border: none; border-top: 1px solid #1a1c29; margin: 30px 0;\"/>")
	bodyBuilder.WriteString("<p style=\"color: #4e4e52; font-size: 0.75em;\">This email was sent automatically by your Bounty Control Center. You can update your settings at any time on localhost.</p>")
	bodyBuilder.WriteString("</body></html>")

	htmlBody := bodyBuilder.String()
	
	// Read SMTP credentials from environment with settings fallback
	smtpHost := os.Getenv("SMTP_HOST")
	if smtpHost == "" {
		smtpHost = settings.SMTPHost
	}

	smtpPort := settings.SMTPPort
	if envPort := os.Getenv("SMTP_PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			smtpPort = p
		}
	}

	smtpUser := os.Getenv("SMTP_USER")
	if smtpUser == "" {
		smtpUser = settings.SMTPUser
	}

	smtpPass := os.Getenv("SMTP_PASS")
	if smtpPass == "" {
		smtpPass = settings.SMTPPass
	}

	if smtpHost == "" {
		return fmt.Errorf("SMTP host not configured")
	}

	// Fetch all subscribers from database
	var subs []Subscriber
	if err := DB.Find(&subs).Error; err != nil {
		log.Printf("Failed to fetch subscribers: %v", err)
	}

	// Fallback to settings.Email if no database subscribers exist
	if len(subs) == 0 {
		if settings.Email != "" {
			subs = append(subs, Subscriber{Email: settings.Email})
		} else {
			return fmt.Errorf("no subscribers set")
		}
	}

	// Loop and send to each subscriber
	var lastErr error
	for _, sub := range subs {
		log.Printf("Sending notification email to subscriber: %s", sub.Email)
		err := sendToSingleEmail(smtpHost, smtpPort, smtpUser, smtpPass, sub.Email, subject, htmlBody)
		if err != nil {
			log.Printf("Failed to send email to %s: %v", sub.Email, err)
			lastErr = err
		}
	}

	return lastErr
}

// sendToSingleEmail handles actual SMTP connection and dispatching for one recipient
func sendToSingleEmail(smtpHost string, smtpPort int, smtpUser string, smtpPass string, toEmail string, subject string, htmlBody string) error {
	addr := fmt.Sprintf("%s:%d", smtpHost, smtpPort)
	msg := []byte("To: " + toEmail + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"MIME-version: 1.0;\nContent-Type: text/html; charset=\"UTF-8\";\r\n\r\n" +
		htmlBody)

	if smtpPort == 465 {
		log.Printf("Connecting to SMTP server via SSL at %s to send to %s...", addr, toEmail)
		tlsConfig := &tls.Config{
			InsecureSkipVerify: false,
			ServerName:         smtpHost,
		}
		
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return fmt.Errorf("TLS dial failed: %w", err)
		}
		defer conn.Close()

		client, err := smtp.NewClient(conn, smtpHost)
		if err != nil {
			return fmt.Errorf("SMTP client initialization failed: %w", err)
		}
		defer client.Close()

		if smtpUser != "" && smtpPass != "" {
			auth := smtp.PlainAuth("", smtpUser, smtpPass, smtpHost)
			if err = client.Auth(auth); err != nil {
				return fmt.Errorf("SMTP auth failed: %w", err)
			}
		}

		if err = client.Mail(smtpUser); err != nil {
			return fmt.Errorf("SMTP MAIL command failed: %w", err)
		}

		if err = client.Rcpt(toEmail); err != nil {
			return fmt.Errorf("SMTP RCPT command failed: %w", err)
		}

		w, err := client.Data()
		if err != nil {
			return fmt.Errorf("SMTP DATA command failed: %w", err)
		}

		_, err = w.Write(msg)
		if err != nil {
			return fmt.Errorf("writing body failed: %w", err)
		}

		err = w.Close()
		if err != nil {
			return fmt.Errorf("closing writer failed: %w", err)
		}

		log.Printf("Email successfully sent via SSL to %s!", toEmail)
		return client.Quit()
	}

	// For port 587/25, use standard smtp.SendMail (uses STARTTLS if available)
	var auth smtp.Auth
	if smtpUser != "" && smtpPass != "" {
		auth = smtp.PlainAuth("", smtpUser, smtpPass, smtpHost)
	}

	log.Printf("Connecting to SMTP server at %s to send to %s...", addr, toEmail)
	err := smtp.SendMail(addr, auth, smtpUser, []string{toEmail}, msg)
	if err != nil {
		return err
	}
	
	log.Printf("Email successfully sent to %s!", toEmail)
	return nil
}
