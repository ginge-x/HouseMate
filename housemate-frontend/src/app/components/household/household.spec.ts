import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Household } from './household';

describe('Household', () => {
  let component: Household;
  let fixture: ComponentFixture<Household>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Household]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Household);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
