"""Small pure reference for job transitions/budgets; persistence is the SQLite DDL.
Not a worker, scheduler, game engine or model integration.
"""
from dataclasses import dataclass
@dataclass
class Budget:
    advisor_sent:int=0
@dataclass
class Job:
    role:str
    status:str='queued'
    attempts:int=0
    current:bool=True
    mode:str='live_model'
    def send(self,budget):
        if self.status not in ('queued','running'):raise ValueError('NOT_SENDABLE')
        if not self.current:raise ValueError('CONTEXT_SUPERSEDED')
        if self.attempts>=2:raise ValueError('ATTEMPTS_EXHAUSTED')
        if self.role=='advisor' and budget.advisor_sent>=30:raise ValueError('SESSION_CALL_LIMIT')
        self.status='running';self.attempts+=1
        if self.role=='advisor':budget.advisor_sent+=1
        # This increment represents a committed `sending` reservation, BEFORE network.
    def complete(self,valid):
        if self.status!='running':raise ValueError('NOT_RUNNING')
        if not self.current:self.status='superseded';return
        self.status='succeeded' if valid else 'fallback'
        self.mode='live_model' if valid else 'offline_template'
    def recover(self):
        if self.status not in ('fallback','failed'):raise ValueError('SUCCESS_NOT_RESAMPLED')
        if not self.current:raise ValueError('CONTEXT_SUPERSEDED')
        if self.attempts>=2:raise ValueError('ATTEMPTS_EXHAUSTED')
        self.status='queued';self.mode='live_model'
    def supersede(self):
        self.current=False
        # Successful historical rows are immutable; current display is a projection.
        if self.status!='succeeded':self.status='superseded'
