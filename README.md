<p align="center">
  <img src="backend/static/assets/scribe_logo.png" alt="Scribe Logo" width="150">
</p>

<h1 align="center">Scribe: An AI-Assisted Annotator</h1>

<p align="center">
  A self-hosted web application for rapidly labelling research papers, designed for both solo researchers and collaborative teams.
</p>

---

Whether you're a solo researcher organizing your literature or part of a team working on a large-scale annotation project, Scribe is designed to streamline your workflow. It's a self-hosted web application built with **FastAPI** that provides a clean interface for viewing and annotating papers, with optional AI-powered suggestions to accelerate your work.

## Key Features

- **Solo & Team Ready**: Works perfectly for an individual researcher, or connect a whole team to a single Google Sheet. The smart queue and paper-locking system ensure no one duplicates work.
- **AI-Assisted Annotation**: Utilizes Google's Gemini models to pre-fill your annotation form, providing suggestions, context, and reasoning.
- **Intuitive Interface**: Clean layout for viewing abstracts, full text, and PDFs side-by-side with your annotation template.
- **Customizable Templates**: Visually build and edit your own annotation schemas to fit any research project.
- **Dynamic Keyword Highlighting**: Quickly surface relevant terms in the text based on your custom templates.
- **Automatic Updates**: The app can check for new versions on GitHub and guide you through a one-click update process.

## Getting Started

Follow these steps to get Scribe running on your local machine.

### 1. Prerequisites

- **Python 3.8+** must be installed and available in your system's PATH.
- **Git** must be installed for cloning and updating the application.

### 2. Clone the Repository

Open a terminal or command prompt and clone the repository to your local machine:

```bash
git clone https://github.com/scottkryski/Scribe.git
cd Scribe
```

### 3. Setup Credentials and Data

To function, the application needs credentials to talk to Google's services and data to annotate. This setup allows you to work privately or as a team.

#### **A. Google Sheets API Credentials (For Writing Annotations)**

The app needs a Google Service Account to read and write data to your Google Sheet. **This file is NOT included in the repository for security reasons.** You must generate your own.

1.  **Follow the detailed, step-by-step instructions in the in-app User Guide** to create a service account and download its JSON key. The guide can be accessed by running the app and clicking the **Guide (📖)** icon.
    - _For Teams:_ Only one person needs to create the service account and share the resulting `credentials.json` file securely with the team.
2.  Rename the downloaded key file to `credentials.json`.
3.  Place this `credentials.json` file inside the `backend/` directory.

#### **B. Gemini API Key (For AI Suggestions)**

The AI features are powered by a Gemini API Key. This is optional if you only wish to annotate manually.

1.  You can get a free key from the **[Google AI Studio](https://aistudio.google.com/app/apikey)**.
2.  You do not need to create a file for this. The first time you run the app, you will be prompted to enter this key on the Settings page.

#### **C. Add Your Datasets**

1.  The application reads papers from `.jsonl` files (JSON Lines, where each line is a valid JSON object representing a paper).
2.  Place your dataset files inside the `backend/data/` directory. The app will automatically discover them.

### 4. Run the Application

Platform-specific scripts are included to set up a virtual environment, install packages, and run the server.

- **On Windows:** Double-click `run.bat`.
- **On macOS/Linux:** Open a terminal and run `./run.sh`. On MacOS you can also double click run.command.

The script will start the server and automatically open the application in your web browser at **[http://127.0.0.1:8000](http://127.0.0.1:8000)**. The server will continue running in the terminal window, even if you close the broswer.

Press `Ctrl+C` or `Cmd+C` in the terminal, or simply close the terminal window to stop it.
