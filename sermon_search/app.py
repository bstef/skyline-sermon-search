from contextlib import asynccontextmanager
from pathlib import Path
from time import perf_counter
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from . import core

@asynccontextmanager
async def lifespan(app):
    core.init()
    yield

app = FastAPI(title='Skyline Sermon Search', lifespan=lifespan)
static = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static), name='static')

@app.get('/')
def home():
    return FileResponse(static / 'index.html')

@app.get('/calendar')
def calendar():
    return FileResponse(static / 'calendar.html')

@app.get('/api/stats')
def stats():
    return core.stats()

@app.get('/api/episodes')
def episodes():
    return core.episodes()

@app.get('/api/search')
def search(q: str = Query(min_length=1,max_length=300), mode: str = Query(default='smart',pattern='^(smart|keyword)$')):
    start = perf_counter()
    result = core.search(q,mode)
    result['elapsed_ms'] = round((perf_counter()-start)*1000)
    return result
