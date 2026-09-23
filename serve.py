import os
from waitress import serve
from app import create_app
serve(create_app(),host='0.0.0.0',port=int(os.environ.get('PORT','8000')),threads=12)
