use alloc::string::String;
use core::fmt;

/// Stable failure codes. They are part of the contract interface: the NEAR wrapper
/// panics with `DOCKSIDE:<code>: <message>` so callers and tests can assert exact causes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DOCKSIDE:{}: {}", self.code, self.message)
    }
}

pub type R<T> = Result<T, Error>;

pub fn err<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(Error {
        code,
        message: message.into(),
    })
}

pub fn ensure(cond: bool, code: &'static str, message: &str) -> R<()> {
    if cond {
        Ok(())
    } else {
        err(code, message)
    }
}
