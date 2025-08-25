import google.genai as genai
from google.genai import types
from ollama import generate, ListResponse, list
import json
from dotenv import load_dotenv, find_dotenv
import os
import asyncio
from pydantic import BaseModel, ValidationError, create_model
from typing import Optional, Literal, Dict, Any, Type
from pathlib import Path
import enum

# This global variable will hold the key for our own internal checks.
GEMINI_API_KEY = None
_genai_configured = False

def configure_genai():
    """
    Loads the Gemini API key from the .env file into the environment.
    The genai client will automatically pick it up from environment variables.
    """
    global GEMINI_API_KEY, _genai_configured
    dotenv_path = find_dotenv()
    load_dotenv(dotenv_path=dotenv_path if dotenv_path else None, override=True)
    
    key_from_env = os.getenv("GEMINI_API_KEY")
    
    if key_from_env:
        GEMINI_API_KEY = key_from_env
        # Set the environment variable that the genai client automatically detects
        os.environ['GOOGLE_API_KEY'] = key_from_env
        _genai_configured = True
        print("SUCCESS: Gemini API key has been loaded into the environment.")
    else:
        print("WARNING: Gemini API key not found. Please add it via the UI.")
        _genai_configured = False

def _generate_prompt_from_template(template: Dict[str, Any]) -> str:
    """Dynamically generates the Gemini prompt from a template definition."""
    
    fields_prompt = ""
    for field in template.get("fields", []):
        field_id = field.get("id")
        field_label = field.get("label")
        field_desc = field.get("description")
        field_type = field.get("type")

        if not all([field_id, field_label, field_desc, field_type]):
            continue

        fields_prompt += f'### For "{field_id}":\n'
        fields_prompt += f'**Task**: Determine the value for "{field_label}".\n'
        if field_type == "select":
            options = ", ".join([f"`{opt}`" for opt in field.get("options", [])])
            fields_prompt += f'**Definition**: {field_desc} You MUST choose one of the following options: {options}.\n'
        else: # boolean
            fields_prompt += f'**Definition**: {field_desc}\n'
        fields_prompt += "\n"

    base_prompt = f"""
**ROLE AND GOAL:**
You are an expert research analyst AI. Your task is to meticulously analyze the research article provided in the attached file and fill out a JSON object with specific details about its methodology and ethical statements, based on a provided template. You must base all your answers *only* on the text of the article in the file.

**OUTPUT FORMAT:**
You MUST respond with a single, valid JSON object that strictly adheres to the schema provided in the instructions. Do not add any explanatory text, markdown formatting, or comments before or after the JSON object.

---
**INSTRUCTIONS FOR FILLING THE JSON:**

For each field defined below, you MUST provide all three of the following pieces of information:

1.  **A value**: A `boolean` (`true`/`false`) for boolean fields, or a `string` from the allowed `enum` list for selection fields.
2.  **`_context`**: A **direct quote** from the text that provides the *best evidence* for your decision. This must be the most relevant sentence or phrase from the article. If your decision is `false` or no evidence was found, this MUST be an empty string `""`.
3.  **`_reasoning`**: A concise explanation of *why* the provided context (or lack thereof) justifies your decision. This field is **mandatory**. If `false`, your reasoning should explicitly state that no supporting evidence was found in the text.

---
**DETAILED GUIDES FOR EACH FIELD:**

{fields_prompt}
"""
    return base_prompt

def _create_dynamic_response_model(template: Dict[str, Any]) -> Type[BaseModel]:
    """Dynamically creates a Pydantic model from a template definition."""
    fields_for_model = {}
    for field in template.get("fields", []):
        field_id = field.get("id")
        field_type = field.get("type")

        if not field_id or not field_type:
            continue

        # Define the main value field
        if field_type == "select":
            options = field.get("options", [])
            if not options: continue
            # Create an Enum for the select options
            enum_name = f"{field_id.capitalize()}Enum"
            field_enum = enum.Enum(enum_name, {opt.replace('-', ''): opt for opt in options})
            fields_for_model[field_id] = (field_enum, ...)
        else: # boolean
            fields_for_model[field_id] = (bool, ...)

        # Define the associated context and reasoning fields
        fields_for_model[f"{field_id}_context"] = (Optional[str], None)
        fields_for_model[f"{field_id}_reasoning"] = (str, ...)

    # Create the dynamic Pydantic model
    DynamicGeminiResponse = create_model(
        'DynamicGeminiResponse',
        **fields_for_model,
        __base__=BaseModel
    )
    
    # We need a wrapper model because the genai client expects the schema to be the top-level object
    WrapperModel = create_model(
        'WrapperModel',
        GeminiResponse=(DynamicGeminiResponse, ...)
    )
    return WrapperModel


def get_gemini_models():
    return ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemma-3-27b-it", "gemma-3n-e4b-it"]


def get_ollama_models():
    try:
        response: ListResponse = list()
        return [model['model'] for model in response['models']]
    except Exception as e:
        print(f"Could not connect to Ollama server to get models: {e}")
        return []

async def get_gemini_response(gemini_model: str, pdf_filepath: Path, template: Dict[str, Any]):
    """
    Analyzes a PDF using a dynamically generated prompt and response schema based on the provided template.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError("Gemini API key is not configured. Please check your .env file.")

    if not pdf_filepath.exists():
        raise FileNotFoundError(f"PDF file not found at: {pdf_filepath}")

    # 1. Generate dynamic components from the template
    try:
        dynamic_prompt = _generate_prompt_from_template(template)
        DynamicResponseModel = _create_dynamic_response_model(template)
        print("Successfully generated dynamic prompt and response model from template.")
    except Exception as e:
        print(f"Error generating dynamic components from template: {e}")
        raise RuntimeError(f"Failed to process the provided template: {e}")

    # 2. Initialize the client and prepare contents
    client = genai.Client(api_key=GEMINI_API_KEY)
    print(f"Reading file bytes for: {pdf_filepath.name}...")
    pdf_bytes = await asyncio.to_thread(pdf_filepath.read_bytes)
    contents = [
        types.Part.from_bytes(data=pdf_bytes, mime_type='application/pdf'),
        dynamic_prompt
    ]

    # 3. Configure and make the API call
    try:
        print(f"Generating content using model: {gemini_model}...")
        
        # Use a thinking budget of 0 for faster, cheaper responses on flash models
        use_thinking_config = "flash" in gemini_model
        
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=DynamicResponseModel,
            temperature=0,
        )
        if use_thinking_config:
            config.thinking_config = types.ThinkingConfig(thinking_budget=0)

        response = await asyncio.to_thread(
            client.models.generate_content,
            model=f'models/{gemini_model}',
            contents=contents,
            config=config
        )
        print("Content generation complete.")
        return response

    except Exception as e:
        print(f"An error occurred during the API call: {e}")
        # Attempt to parse a more helpful error message from the API response if possible
        if hasattr(e, 'response') and hasattr(e.response, 'text'):
            raise RuntimeError(f"Gemini API Error: {e.response.text}")
        raise

if __name__ == "__main__":
    # --- Configuration for Testing ---
    TEST_OPTION = 2 # or 2

    if TEST_OPTION == 1:
        configure_genai()

        try:
            test_pdf_path = Path(__file__).parent.parent / "pdfs" / "Alves2011-emotional_problems_in_preadolescents.pdf"
            default_template_path = Path(__file__).parent.parent / "templates" / "default.json"
        except NameError:
            # Fallback for different execution context
            test_pdf_path = Path("pdfs/Alves2011-emotional_problems_in_preadolescents.pdf")
            default_template_path = Path("templates/default.json")

        test_gemini_model = "gemini-1.5-flash-latest"

        # --- Run the Test ---
        print(f"\n--- Starting Gemini Response Test with {test_gemini_model} ---")
        print(f"Attempting to analyze PDF: {test_pdf_path}")

        if not test_pdf_path.exists():
            print(f"ERROR: Test PDF not found at {test_pdf_path}.")
        elif not default_template_path.exists():
            print(f"ERROR: Default template not found at {default_template_path}.")
        elif not GEMINI_API_KEY:
            print("ERROR: Gemini API key not configured. Please check your .env file.")
        else:
            try:
                with open(default_template_path, 'r') as f:
                    test_template = json.load(f)
                
                response = asyncio.run(get_gemini_response(
                    gemini_model=test_gemini_model, 
                    pdf_filepath=test_pdf_path,
                    template=test_template
                ))
                print("\n--- Gemini Response ---")
                print(response.text)
            except Exception as e:
                print(f"An unexpected error occurred: {e}")
                
        print("\n--- Test Complete ---")

    elif TEST_OPTION == 2:
        models = get_ollama_models()
        print(f"Models: {models}")