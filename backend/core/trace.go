package core

type Span struct {
	Name     string
	Start    int64
	End      int64
	Duration int64
}

type Trace struct {
	ID    string
	Spans []Span
}
