import requests
import xmltodict
import csv
from datetime import datetime

def fetch_sec_filings():
    url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom"
    headers = {
        'User-Agent': 'YourCompanyName Automated Tool v1.0 - contact@yourcompany.com'
    }

    response = requests.get(url, headers=headers)

    if response.status_code == 200:
        data = xmltodict.parse(response.content)

        # Extract the entries from the feed
        entries = data['feed']['entry']
        
        # Prepare the CSV file
        with open('sec_filings_last_24_hours.csv', 'w', newline='') as csvfile:
            fieldnames = ['title', 'link', 'summary', 'updated']
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()

            for entry in entries:
                writer.writerow({
                    'title': entry.get('title', ''),
                    'link': entry.get('link', {}).get('@href', ''),
                    'summary': entry.get('summary', ''),
                    'updated': entry.get('updated', '')
                })
        
        print(f"Saved {len(entries)} filings to sec_filings_last_24_hours.csv")
    else:
        print(f"Error: {response.status_code}")

# Fetch and save the filings
fetch_sec_filings()
