import requests
from bs4 import BeautifulSoup
from datetime import datetime
import csv

def fetch_ftc_data_security_cases():
    url = "https://www.ftc.gov/legal-library/browse/cases-proceedings"
    headers = {
        'User-Agent': 'Mozilla/5.0 (platform; rv:geckoversion) Gecko/geckotrail'
    }

    response = requests.get(url, headers=headers)
    soup = BeautifulSoup(response.content, 'html.parser')
    
    cases = []

    # Scrape the most recent 100 cases or those within the last 30 days
    url = "https://www.ftc.gov/legal-library/browse/cases-proceedings"
    response = requests.get(url)
    soup = BeautifulSoup(response.content, 'html.parser')

    for item in soup.select('.views-row'):
        title = item.find('h3').get_text(strip=True) if item.find('h3') else "Title not found"
        
        # Get the full URL from the <a> tag inside the 'h3'
        link_tag = item.find('h3').find('a') if item.find('h3') else None
        link = f"https://www.ftc.gov{link_tag['href']}" if link_tag and 'href' in link_tag.attrs else "Link not found"
        
        # Locate the date with better specificity
        try:
            date_div = item.find('div', class_='field--type-datetime')
            date_str = date_div.find('time').get_text(strip=True) if date_div else "Date not found"
            case_date = datetime.strptime(date_str, "%B %d, %Y")
        except (AttributeError, ValueError):
            date_str = "Date not found"
            case_date = None
        
        # Extract 'Type of Action'
        try:
            action_type_label = item.find('div', class_='field__label', string="Type of Action")
            action_type = action_type_label.find_next_sibling('div').get_text(strip=True) if action_type_label else "Action type not found"
        except AttributeError:
            action_type = "Action type not found"

        # Extract 'Case Status'
        try:
            status_label = item.find('div', class_='field__label', string="Case Status")
            case_status = status_label.find_next_sibling('div').get_text(strip=True) if status_label else "Case status not found"
        except AttributeError:
            case_status = "Case status not found"

        # Extract 'Docket Number'
        try:
            docket_label = item.find('div', class_='field__label', string="Docket Number")
            docket_number = docket_label.find_next_sibling('div').get_text(strip=True) if docket_label else "Docket number not found"
        except AttributeError:
            docket_number = "Docket number not found"

        cases.append({
            'title': title,
            'link': link,
            'date': date_str,
            'type_of_action': action_type,
            'case_status': case_status,
            'docket_number': docket_number
        })
        
        # Check if within the last 30 days, but still include cases if the date is missing
        if case_date and (datetime.now() - case_date).days > 30:
            continue
        
        if len(cases) >= 100:
            break

    # Print for debug
    #for case in cases:
    #    print(case)
    
    # Save to CSV with a timestamp in the filename
    save_to_csv(cases)

def save_to_csv(data):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")  # Create a timestamp
    filename = f'ftc_data_security_cases_{timestamp}.csv'  # Append timestamp to filename
    
    keys = data[0].keys()  # Extract headers from the first item
    with open(filename, 'w', newline='') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=keys)
        writer.writeheader()
        writer.writerows(data)

# Fetch the data for analysis
fetch_ftc_data_security_cases()
