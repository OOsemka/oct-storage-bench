package main

import (
	"crypto/tls"
	"log"
	"net/http"
	"os"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("benchmark-runner starting")

	mux := http.NewServeMux()
	registerHandlers(mux)

	// Health check on HTTP 8080
	go func() {
		healthMux := http.NewServeMux()
		healthMux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		})
		log.Println("health listener on :8080")
		if err := http.ListenAndServe(":8080", healthMux); err != nil {
			log.Fatalf("health listener: %v", err)
		}
	}()

	// TLS listener on 8443 (serving cert injected by OpenShift)
	certFile := envOrDefault("TLS_CERT", "/var/serving-cert/tls.crt")
	keyFile := envOrDefault("TLS_KEY", "/var/serving-cert/tls.key")

	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	srv := &http.Server{
		Addr:      ":8443",
		Handler:   mux,
		TLSConfig: tlsCfg,
	}

	log.Println("HTTPS listener on :8443")
	if err := srv.ListenAndServeTLS(certFile, keyFile); err != nil {
		log.Fatalf("HTTPS listener: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
